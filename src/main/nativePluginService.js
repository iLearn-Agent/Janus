import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bundledCodexCandidates, codexEnv, resolveCodexBinary } from './codex.js';
import { codexConfigStatus, parseSimpleToml, sharedAuthPath, sharedConfigPath } from './codexConfig.js';
import { nativePluginAccountHome } from './nativePluginState.js';
import { ensureDir, safeJsonParse } from './utils.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const OFFICIAL_MARKETPLACE_TIMEOUT_MS = 120_000;
export const OFFICIAL_CODEX_MARKETPLACE_SOURCE = 'openai/plugins';
export const OFFICIAL_CODEX_MARKETPLACE_NAMES = new Set(['openai-curated', 'openai-api-curated']);
export const MINIMUM_CODEX_PLUGIN_VERSION = '0.144.3';

export class NativePluginError extends Error {
  constructor(message, code = 'codex_plugin_failed', details = {}) {
    super(message);
    this.name = 'NativePluginError';
    this.code = code;
    this.details = details;
  }
}

export function createNativePluginService({
  root,
  resolveBinary = resolveCodexBinary,
  envForHome = codexEnv,
  binaryArgs = [],
  officialMarketplaceRoots = null,
} = {}) {
  const queues = new Map();
  const officialMarketplaceQueues = new Map();
  let runtimeCapabilityPromise = null;
  const sharedOfficialMarketplaceRoots = Array.isArray(officialMarketplaceRoots)
    ? officialMarketplaceRoots
    : [
        String(process.env.JANUS_CODEX_OFFICIAL_MARKETPLACE_ROOT || '').trim(),
        path.join(os.homedir(), '.codex', '.tmp', 'plugins'),
      ].filter(Boolean);

  const accountHome = (userId) => {
    const home = nativePluginAccountHome(root, userId);
    if (!home) throw new NativePluginError('请先登录后再管理 Codex 插件。', 'codex_plugin_auth_required');
    return home;
  };

  const prepareAccountHome = async (userId) => {
    const home = accountHome(userId);
    await ensureDir(home);
    const credentialSource = codexConfigStatus(root).credentialSource;
    if (['embedded', 'development'].includes(credentialSource)) {
      await fs.promises.writeFile(path.join(home, 'auth.json'), '{}\n', 'utf8');
    } else {
      await fs.promises.copyFile(sharedAuthPath(root), path.join(home, 'auth.json'));
    }
    await linkOfficialMarketplaceSnapshot(home, sharedOfficialMarketplaceRoots);
    return home;
  };

  const runtimeCapability = () => {
    if (!runtimeCapabilityPromise) {
      runtimeCapabilityPromise = inspectPluginRuntime({ root, resolveBinary, envForHome, binaryArgs });
    }
    return runtimeCapabilityPromise;
  };

  const run = async (userId, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
    const runtime = await runtimeCapability();
    if (!runtime.supported) {
      throw new NativePluginError(runtime.error || '当前 Codex CLI 不支持插件。', runtime.code || 'codex_plugin_unsupported', {
        version: runtime.version,
        source: runtime.source,
        minimumVersion: runtime.minimumVersion,
      });
    }
    const home = await prepareAccountHome(userId);
    const result = await runPluginCommand(runtime.binary, [...binaryArgs, 'plugin', ...args], {
      cwd: root,
      env: envForHome(root, home),
      timeoutMs,
    });
    if (result.code !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim();
      const unsupported = /(?:unrecognized|unknown) subcommand[^\n]*plugin/i.test(detail);
      throw new NativePluginError(detail || `Codex 插件命令失败（退出码 ${result.code}）。`,
        unsupported ? 'codex_plugin_unsupported' : 'codex_plugin_command_failed', { exitCode: result.code });
    }
    const parsed = safeJsonParse(result.stdout, null);
    if (parsed == null) throw new NativePluginError('Codex 插件命令返回了无法识别的数据。', 'codex_plugin_invalid_response');
    return parsed;
  };

  const serialize = (userId, operation) => {
    const key = String(userId || '');
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    const tracked = next.finally(() => {
      if (queues.get(key) === tracked) queues.delete(key);
    });
    queues.set(key, tracked);
    return tracked;
  };

  const ensureOfficialMarketplace = (userId) => {
    const key = String(userId || '');
    const pending = officialMarketplaceQueues.get(key);
    if (pending) return pending;
    const operation = (async () => {
      const current = await run(userId, ['marketplace', 'list', '--json']);
      if (hasOfficialMarketplace(current)) return current;
      try {
        await run(userId, ['marketplace', 'add', OFFICIAL_CODEX_MARKETPLACE_SOURCE, '--json'], {
          timeoutMs: OFFICIAL_MARKETPLACE_TIMEOUT_MS,
        });
      } catch (error) {
        throw new NativePluginError(
          `无法加载 Codex 官方插件目录：${error?.message || String(error)}`,
          'codex_official_marketplace_unavailable',
          { source: OFFICIAL_CODEX_MARKETPLACE_SOURCE, causeCode: error?.code || '' },
        );
      }
      const refreshed = await run(userId, ['marketplace', 'list', '--json']);
      if (!hasOfficialMarketplace(refreshed)) {
        throw new NativePluginError(
          'Codex 官方插件目录初始化后仍不可用。请检查网络连接并重试。',
          'codex_official_marketplace_unavailable',
          { source: OFFICIAL_CODEX_MARKETPLACE_SOURCE },
        );
      }
      return refreshed;
    })();
    officialMarketplaceQueues.set(key, operation);
    return operation.finally(() => {
      if (officialMarketplaceQueues.get(key) === operation) officialMarketplaceQueues.delete(key);
    });
  };

  const list = async (userId) => {
    const runtime = await runtimeCapability();
    const capability = publicRuntimeCapability(runtime);
    if (!runtime.supported) {
      const legacyMcpConflicts = await detectLegacyGithubMcpConflicts({
        root, userId, runtime, prepareAccountHome, envForHome, binaryArgs,
      });
      return { capability, installed: [], available: [], marketplaces: [], legacyMcpConflicts };
    }
    try {
      const marketplaceResult = await ensureOfficialMarketplace(userId);
      const plugins = await run(userId, ['list', '--available', '--json']);
      const legacyMcpConflicts = await detectLegacyGithubMcpConflicts({
        root, userId, runtime, prepareAccountHome, envForHome, binaryArgs,
      });
      const installed = await Promise.all((plugins.installed || []).map(enrichPlugin));
      const available = await Promise.all((plugins.available || []).map(enrichPlugin));
      return {
        capability,
        installed,
        available,
        marketplaces: Array.isArray(marketplaceResult.marketplaces) ? marketplaceResult.marketplaces : [],
        legacyMcpConflicts,
      };
    } catch (error) {
      if (!['codex_plugin_cli_unavailable', 'codex_plugin_unsupported'].includes(error?.code)) throw error;
      return {
        capability: { ...capability, supported: false, error: error.message, code: error.code },
        installed: [], available: [], marketplaces: [], legacyMcpConflicts,
      };
    }
  };

  const verifyMutation = async (userId, pluginId, installed) => {
    const catalog = await list(userId);
    const matching = catalog.installed.find((item) => item.pluginId === pluginId) || null;
    const present = Boolean(matching && matching.installed !== false && matching.enabled !== false);
    if (present !== installed) {
      throw new NativePluginError(
        installed ? 'Codex 未能确认插件已安装。' : 'Codex 未能确认插件已卸载。',
        'codex_plugin_verification_failed',
      );
    }
    return catalog;
  };

  return {
    accountHome,
    list,
    install(userId, pluginId = '') {
      return serialize(userId, async () => {
        const id = cleanPluginId(pluginId);
        const before = await list(userId);
        if (before.capability?.supported === false) {
          throw new NativePluginError(
            before.capability.error || '当前 Codex CLI 不支持插件。',
            before.capability.code || 'codex_plugin_unsupported',
            before.capability,
          );
        }
        if (![...before.installed, ...before.available].some((item) => item.pluginId === id)) {
          throw new NativePluginError(`当前 marketplace 中未找到插件：${id}`, 'codex_plugin_not_found');
        }
        await run(userId, ['add', id, '--json']);
        return verifyMutation(userId, id, true);
      });
    },
    remove(userId, pluginId = '') {
      return serialize(userId, async () => {
        const id = cleanPluginId(pluginId);
        await run(userId, ['remove', id, '--json']);
        return verifyMutation(userId, id, false);
      });
    },
    addMarketplace(userId, { source = '', ref = '', sparse = [], confirmed = false } = {}) {
      return serialize(userId, async () => {
        if (confirmed !== true) throw new NativePluginError('添加第三方 marketplace 需要显式确认。', 'codex_marketplace_confirmation_required');
        const cleanSource = validateMarketplaceSource(source);
        const args = ['marketplace', 'add', cleanSource];
        if (String(ref || '').trim()) args.push('--ref', String(ref).trim());
        for (const item of Array.isArray(sparse) ? sparse : []) {
          const clean = String(item || '').trim();
          if (clean) args.push('--sparse', clean);
        }
        args.push('--json');
        await run(userId, args, { timeoutMs: 120_000 });
        return list(userId);
      });
    },
    upgradeMarketplace(userId, marketplace = '') {
      return serialize(userId, async () => {
        const name = cleanMarketplaceName(marketplace);
        await run(userId, ['marketplace', 'upgrade', name, '--json'], { timeoutMs: 120_000 });
        return list(userId);
      });
    },
    removeMarketplace(userId, marketplace = '') {
      return serialize(userId, async () => {
        const name = cleanMarketplaceName(marketplace);
        if (OFFICIAL_CODEX_MARKETPLACE_NAMES.has(name)) {
          throw new NativePluginError('Codex 官方 marketplace 是内置插件目录，不能移除。', 'codex_official_marketplace_required');
        }
        const catalog = await list(userId);
        const installed = catalog.installed.filter((item) => item.marketplaceName === name);
        if (installed.length) {
          throw new NativePluginError(`请先卸载该 marketplace 中的插件：${installed.map((item) => item.name).join('、')}`,
            'codex_marketplace_in_use');
        }
        await run(userId, ['marketplace', 'remove', name, '--json']);
        return list(userId);
      });
    },
  };
}

function hasOfficialMarketplace(value = {}) {
  return (Array.isArray(value.marketplaces) ? value.marketplaces : [])
    .some((item) => OFFICIAL_CODEX_MARKETPLACE_NAMES.has(String(item?.name || '')));
}

async function linkOfficialMarketplaceSnapshot(accountHome, candidates = []) {
  const target = path.join(accountHome, '.tmp', 'plugins');
  if (await validOfficialMarketplaceSnapshot(target)) {
    const targetRealPath = await fs.promises.realpath(target).catch(() => target);
    if (await syncOfficialMarketplaceSha(target, targetRealPath)) return target;
    await fs.promises.rm(target, { recursive: true, force: true });
  }
  const targetRealPath = await fs.promises.realpath(target).catch(() => '');
  for (const candidateValue of candidates) {
    const candidate = path.resolve(String(candidateValue || ''));
    if (!candidateValue || candidate === path.resolve(target)) continue;
    if (!await validOfficialMarketplaceSnapshot(candidate)) continue;
    const candidateRealPath = await fs.promises.realpath(candidate).catch(() => '');
    if (!candidateRealPath) continue;
    const sha = await officialMarketplaceSha(candidateRealPath);
    if (!sha) continue;
    if (targetRealPath && targetRealPath === candidateRealPath) {
      await writeOfficialMarketplaceSha(target, sha);
      return target;
    }
    await ensureDir(path.dirname(target));
    await fs.promises.rm(target, { recursive: true, force: true });
    try {
      await fs.promises.symlink(candidateRealPath, target, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code !== 'EEXIST' || !await validOfficialMarketplaceSnapshot(target)) throw error;
    }
    await writeOfficialMarketplaceSha(target, sha);
    return target;
  }
  return '';
}

async function syncOfficialMarketplaceSha(target, source) {
  const sha = await officialMarketplaceSha(source);
  if (!sha) return false;
  await writeOfficialMarketplaceSha(target, sha);
  return true;
}

async function officialMarketplaceSha(snapshotRoot) {
  try {
    const value = String(await fs.promises.readFile(
      path.join(path.dirname(snapshotRoot), 'plugins.sha'),
      'utf8',
    )).trim();
    return /^[a-f0-9]{40,64}$/i.test(value) ? value.toLowerCase() : '';
  } catch {
    return '';
  }
}

async function writeOfficialMarketplaceSha(snapshotRoot, sha) {
  const shaPath = path.join(path.dirname(snapshotRoot), 'plugins.sha');
  await ensureDir(path.dirname(shaPath));
  await fs.promises.writeFile(shaPath, `${sha}\n`, 'utf8');
}

async function validOfficialMarketplaceSnapshot(root = '') {
  if (!root) return false;
  for (const filename of ['api_marketplace.json', 'marketplace.json']) {
    try {
      const manifest = safeJsonParse(await fs.promises.readFile(
        path.join(root, '.agents', 'plugins', filename),
        'utf8',
      ), null);
      if (!OFFICIAL_CODEX_MARKETPLACE_NAMES.has(String(manifest?.name || ''))) continue;
      if ((Array.isArray(manifest.plugins) ? manifest.plugins : [])
        .some((plugin) => String(plugin?.name || '').toLowerCase() === 'zotero')) return true;
    } catch {}
  }
  return false;
}

async function inspectPluginRuntime({ root, resolveBinary, envForHome, binaryArgs }) {
  const minimumVersion = MINIMUM_CODEX_PLUGIN_VERSION;
  const codexBin = await resolveBinary();
  const source = codexBinarySource(codexBin);
  if (!codexBin) {
    return {
      supported: false, version: '', source, minimumVersion,
      error: '当前 Codex CLI 不可用。请重新安装或升级 Janus。',
      code: 'codex_plugin_cli_unavailable', binary: '',
    };
  }
  const commandEnv = envForHome(root, null);
  const versionResult = await runPluginCommand(codexBin, [...binaryArgs, '--version'], {
    cwd: root, env: commandEnv, timeoutMs: 10_000,
  }).catch((error) => ({ code: -1, stdout: '', stderr: error.message }));
  const version = parseCodexVersion(`${versionResult.stdout || ''}\n${versionResult.stderr || ''}`);
  if (versionResult.code !== 0 || !version) {
    return {
      supported: false, version, source, minimumVersion,
      error: '无法确认当前 Codex CLI 版本。请重新安装或升级 Janus。',
      code: 'codex_plugin_cli_unavailable', binary: codexBin,
    };
  }
  if (compareVersions(version, minimumVersion) < 0) {
    return {
      supported: false, version, source, minimumVersion,
      error: `当前 Codex CLI v${version} 过旧，插件功能需要 v${minimumVersion} 或更高版本。请升级或重新安装 Janus。`,
      code: 'codex_plugin_runtime_upgrade_required', binary: codexBin,
    };
  }
  const helpResult = await runPluginCommand(codexBin, [...binaryArgs, 'plugin', '--help'], {
    cwd: root, env: commandEnv, timeoutMs: 10_000,
  }).catch((error) => ({ code: -1, stdout: '', stderr: error.message }));
  const help = `${helpResult.stdout || ''}\n${helpResult.stderr || ''}`;
  const missingCommands = ['add', 'list', 'remove'].filter((command) => !new RegExp(`^\\s*${command}\\s+`, 'mi').test(help));
  if (helpResult.code !== 0 || missingCommands.length) {
    return {
      supported: false, version, source, minimumVersion,
      error: '当前 Codex CLI 未提供完整的 Plugin 管理命令。请升级或重新安装 Janus。',
      code: 'codex_plugin_unsupported', binary: codexBin,
    };
  }
  return { supported: true, version, source, minimumVersion, error: '', code: '', binary: codexBin };
}

function publicRuntimeCapability(runtime = {}) {
  return {
    supported: runtime.supported === true,
    version: String(runtime.version || ''),
    source: String(runtime.source || ''),
    minimumVersion: String(runtime.minimumVersion || MINIMUM_CODEX_PLUGIN_VERSION),
    error: String(runtime.error || ''),
    code: String(runtime.code || ''),
  };
}

function codexBinarySource(codexBin = '') {
  if (!codexBin) return '';
  const normalized = normalizeBinaryPath(codexBin);
  const configured = String(process.env.JANUS_CODEX_BIN || '').trim();
  if (configured && normalizeBinaryPath(configured) === normalized) return 'configured';
  if (bundledCodexCandidates().some((candidate) => normalizeBinaryPath(candidate) === normalized)) return 'bundled';
  return 'system';
}

function normalizeBinaryPath(value = '') {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function parseCodexVersion(value = '') {
  return String(value || '').match(/(?:^|\s)(\d+\.\d+\.\d+)(?:[-+\s]|$)/)?.[1] || '';
}

function compareVersions(left = '', right = '') {
  const a = String(left || '').split('.').map((item) => Number(item) || 0);
  const b = String(right || '').split('.').map((item) => Number(item) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}

async function detectLegacyGithubMcpConflicts({ root, userId, runtime, prepareAccountHome, envForHome, binaryArgs }) {
  const conflicts = [];
  try {
    const config = parseSimpleToml(await fs.promises.readFile(sharedConfigPath(root), 'utf8'));
    const githubName = Object.keys(config.mcp_servers || {}).find((name) => name.toLowerCase() === 'github');
    if (githubName) conflicts.push(legacyMcpConflict('janus_config'));
  } catch {}
  if (!runtime.binary) return conflicts;
  try {
    const home = await prepareAccountHome(userId);
    const result = await runPluginCommand(runtime.binary, [...binaryArgs, 'mcp', 'list', '--json'], {
      cwd: root, env: envForHome(root, home), timeoutMs: 10_000,
    });
    const parsed = result.code === 0 ? safeJsonParse(result.stdout, null) : null;
    const servers = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.servers) ? parsed.servers : [];
    if (servers.some((server) => String(server?.name || '').toLowerCase() === 'github')) {
      conflicts.push(legacyMcpConflict('plugin_account'));
    }
  } catch {}
  return conflicts;
}

function legacyMcpConflict(source) {
  return {
    name: 'github',
    kind: 'mcp',
    source,
    message: '检测到旧 GitHub MCP 配置；它不是 Codex Plugin，不会出现在插件目录或 @ 列表中。',
  };
}

function cleanPluginId(value = '') {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.length > 240) {
    throw new NativePluginError('插件标识无效。', 'codex_plugin_invalid_id');
  }
  return id;
}

function cleanMarketplaceName(value = '') {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.length > 160) {
    throw new NativePluginError('Marketplace 名称无效。', 'codex_marketplace_invalid_name');
  }
  return name;
}

function validateMarketplaceSource(value = '') {
  const source = String(value || '').trim();
  if (!source || source.length > 2000 || /[\r\n\0]/.test(source)) {
    throw new NativePluginError('Marketplace 来源无效。', 'codex_marketplace_invalid_source');
  }
  if (/^(?:https:\/\/|ssh:\/\/|git@|[\w.-]+\/[\w.-]+(?:@[^\s]+)?)$/i.test(source)) return source;
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new NativePluginError('本地 marketplace 目录不存在。', 'codex_marketplace_source_missing');
  }
  return resolved;
}

async function enrichPlugin(item = {}) {
  const sourcePath = String(item.source?.path || '').trim();
  let manifest = {};
  if (sourcePath) {
    try {
      manifest = JSON.parse(await fs.promises.readFile(path.join(sourcePath, '.codex-plugin', 'plugin.json'), 'utf8'));
    } catch {}
  }
  const pluginInterface = manifest.interface || {};
  const english = pluginInterface.localizations?.en || pluginInterface.i18n?.en || manifest.localizations?.en || {};
  const chinese = pluginInterface.localizations?.['zh-CN'] || pluginInterface.localizations?.zh_cn
    || pluginInterface.i18n?.['zh-CN'] || pluginInterface.i18n?.zh_cn || manifest.localizations?.['zh-CN'] || {};
  return {
    ...item,
    displayName: pluginInterface.displayName || manifest.name || item.name || '',
    description: pluginInterface.shortDescription || manifest.description || '',
    displayNameEn: pluginInterface.displayNameEn || pluginInterface.display_name_en || manifest.displayNameEn || english.displayName || english.name || '',
    displayNameZhCn: pluginInterface.displayNameZhCn || pluginInterface.display_name_zh_cn || manifest.displayNameZhCn || chinese.displayName || chinese.name || '',
    descriptionEn: pluginInterface.shortDescriptionEn || pluginInterface.descriptionEn || pluginInterface.description_en
      || manifest.descriptionEn || english.shortDescription || english.description || '',
    descriptionZhCn: pluginInterface.shortDescriptionZhCn || pluginInterface.descriptionZhCn || pluginInterface.description_zh_cn
      || manifest.descriptionZhCn || chinese.shortDescription || chinese.description || '',
    category: pluginInterface.category || item.category || '',
    brandColor: pluginInterface.brandColor || '',
  };
}

function runPluginCommand(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new NativePluginError('Codex 插件命令执行超时。', 'codex_plugin_timeout'));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new NativePluginError(`无法启动 Codex 插件命令：${error.message}`, 'codex_plugin_cli_unavailable'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: Number(code ?? -1), stdout, stderr });
    });
  });
}
