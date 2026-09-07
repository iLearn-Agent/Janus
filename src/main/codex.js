import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import tls from 'node:tls';

import { codexHomeForSession, codexMemoriesDir, tmpDir } from './paths.js';
import { codexConfigStatus, codexConfigTextForRuntime, codexMemoryConfig, codexMultiAgentConfig, codexPrivateSessionConfig, loadAuthEnv, sharedAuthPath, sharedConfigArgs, sharedConfigPath } from './codexConfig.js';
import { clipText, ensureDir, newId, readText } from './utils.js';
import { codexHarnessAssignment, writeCodexAgentHarness } from './codexAgentHarness.js';
import { linkNativePluginCache, nativePluginAccountState, nativePluginConfigOverlay } from './nativePluginState.js';
import { createFileChangeSnapshotRunAsync } from './fileChangeSnapshots.js';
import {
  assertManagedProviderQuotaAvailable,
  modelUsageProviderState,
  recordModelTokenUsage,
} from './managedProviderUsage.js';
import {
  codexAppServerArgs,
  codexCollaborationMode,
  codexExecutionBackend,
  createCodexStreamEventParser,
  codexGeneratedImagePath,
  normalizeCodexFileChangeDiff,
  normalizeCodexFileChangeKind,
  codexPermissionProfile,
  codexProcessEventForItem,
  codexStreamEvent,
  codexTokenUsage,
  extractCodexThreadId,
  sanitizeProgress,
  sanitizeProcessProtocolValue,
  stripProcessSummary,
} from './modules/codex/index.js';
import { getApplicationLogger } from '../shared/logging/index.js';

export {
  codexAppServerArgs,
  codexCollaborationMode,
  codexExecutionBackend,
  createCodexStreamEventParser,
  codexGeneratedImagePath,
  normalizeCodexFileChangeDiff,
  normalizeCodexFileChangeKind,
  codexPermissionProfile,
  codexProcessEventForItem,
  codexStreamEvent,
  codexTokenUsage,
  extractCodexThreadId,
  sanitizeProcessProtocolValue,
} from './modules/codex/index.js';

export class CodexUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'JanusUnavailable';
  }
}

export function codexExecProcessFailure(error) {
  if (error instanceof CodexUnavailable) return error;
  const detail = String(error?.message || error || 'unknown process error');
  const timeout = /Process timed out after (\d+)ms/i.exec(detail);
  if (timeout) {
    const seconds = Math.max(1, Math.round(Number(timeout[1] || 0) / 1000));
    const failure = new CodexUnavailable(`Codex model request timed out after ${seconds}s before a response completed.`);
    failure.code = 'codex_request_timeout';
    failure.cause = error;
    return failure;
  }
  if (error?.name === 'AbortError') {
    const failure = new CodexUnavailable('Codex model request was cancelled before it completed.');
    failure.code = 'codex_request_cancelled';
    failure.cause = error;
    return failure;
  }
  const failure = new CodexUnavailable(`Codex CLI could not be launched (${detail}). Set JANUS_CODEX_BIN to a runnable CLI binary.`);
  failure.code = 'codex_cli_launch_failed';
  failure.cause = error;
  return failure;
}

export const DEFAULT_CODEX_SANDBOX = process.env.JANUS_CODEX_SANDBOX || 'danger-full-access';
const require = createRequire(import.meta.url);
export const JANUS_CLIENT_VERSION = String(require('../../package.json').version || '0.0.0');
const appServerHelpCache = new Map();
let resolvedCodexProxyEnv = {};
let codexProviderRelayUrl = '';
let codexProviderRelayError = '';
const codexModelCapacityCooldowns = new Map();
const activeCodexChildren = new Set();
const activeCodexChildMetadata = new Map();
const CODEX_FIRST_RESPONSE_MAX_WAIT_CYCLES = 5;
const codexLogger = getApplicationLogger('codex', { testFileName: 'codex-process.jsonl' });

export async function queryWindowsSandboxReadiness(request) {
  try {
    return {
      supported: true,
      readiness: await request('windowsSandbox/readiness', {}),
    };
  } catch (error) {
    if (!isUnsupportedAppServerMethod(error, 'windowsSandbox/readiness')) throw error;
    return { supported: false, readiness: null };
  }
}

function isUnsupportedAppServerMethod(error, method) {
  const message = String(error?.message || error || '');
  return message.includes(String(method || ''))
    && /(unknown variant|unknown method|method not found|unsupported method)/i.test(message);
}

export async function setCodexThreadMemoryMode(request, threadId, enabled = true) {
  try {
    await request('thread/memoryMode/set', {
      threadId,
      mode: enabled ? 'enabled' : 'disabled',
    });
    return true;
  } catch (error) {
    if (!isUnsupportedAppServerMethod(error, 'thread/memoryMode/set')) throw error;
    return false;
  }
}

export function codexThreadSupportsMetadataUpdates({ ephemeral = false } = {}) {
  return !ephemeral;
}

export async function ensureWindowsSandboxReady({
  request,
  cwd,
  createSetupWaiter = () => ({ promise: Promise.resolve(), cancel() {} }),
} = {}) {
  try {
    const initialReadiness = await queryWindowsSandboxReadiness(request);
    const status = initialReadiness.readiness?.status || '';
    if (status === 'ready') return { readinessSupported: true, setupStarted: false, status };

    const setupWaiter = createSetupWaiter();
    setupWaiter.promise?.catch(() => {});
    const setup = await request('windowsSandbox/setupStart', { mode: 'unelevated', cwd });
    if (setup?.started) {
      await setupWaiter.promise;
      return { readinessSupported: initialReadiness.supported, setupStarted: true, status: 'ready' };
    }

    setupWaiter.cancel?.();
    if (!initialReadiness.supported) {
      return { readinessSupported: false, setupStarted: false, status: 'compatibility_fallback' };
    }
    const nextReadiness = await queryWindowsSandboxReadiness(request);
    if (nextReadiness.readiness?.status !== 'ready') {
      throw new Error(status === 'updateRequired'
        ? 'Windows sandbox requires an update or administrator setup in Codex.'
        : 'Windows sandbox is not configured and could not be initialized.');
    }
    return { readinessSupported: true, setupStarted: false, status: 'ready' };
  } catch (cause) {
    if (cause?.code === 'sandbox_workspace_write_unavailable') throw cause;
    const error = new Error(`Windows workspace-write sandbox is unavailable: ${String(cause?.message || cause)}`);
    error.code = 'sandbox_workspace_write_unavailable';
    error.cause = cause;
    throw error;
  }
}

async function compatibleAppServerArgs(codexBin) {
  if (!appServerHelpCache.has(codexBin)) {
    appServerHelpCache.set(codexBin, runProcess(codexBin, ['app-server', '--help'], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000,
    }).then((result) => `${result.stdout}\n${result.stderr}`).catch(() => ''));
  }
  return codexAppServerArgs(await appServerHelpCache.get(codexBin));
}

function isWindowsAppsPath(candidate) {
  return candidate.split(/[\\/]+/).includes('WindowsApps');
}

function executableCandidates(command) {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return [command];
  }
  const pathEnv = process.env.PATH || '';
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];
  const results = [];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      results.push(path.join(dir, `${command}${ext}`));
    }
  }
  return results;
}

function which(command) {
  for (const candidate of executableCandidates(command)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
}

function localCodexCandidates() {
  const candidates = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const binRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
    if (fs.existsSync(binRoot)) {
      for (const version of fs.readdirSync(binRoot, { withFileTypes: true })) {
        if (!version.isDirectory()) continue;
        candidates.push(path.join(binRoot, version.name, 'codex.exe'));
        candidates.push(path.join(binRoot, version.name, 'codex'));
      }
    }
  }
  return candidates
    .filter((candidate) => fs.existsSync(candidate))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
}

const CODEX_TARGETS = {
  'linux:x64': { packageName: 'codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'linux:arm64': { packageName: 'codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  'darwin:x64': { packageName: 'codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'darwin:arm64': { packageName: 'codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'win32:x64': { packageName: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  'win32:arm64': { packageName: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
};

function unpackedAsarPath(candidate) {
  const marker = `${path.sep}app.asar${path.sep}`;
  return candidate.includes(marker) ? candidate.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`) : candidate;
}

function bundledCodexPackageRoots() {
  try {
    return [path.dirname(require.resolve('@openai/codex/package.json'))];
  } catch {
    return [];
  }
}

export function bundledCodexCandidates({
  platform = process.platform,
  arch = process.arch,
  packageRoots = bundledCodexPackageRoots(),
} = {}) {
  const target = CODEX_TARGETS[`${platform}:${arch}`];
  if (!target) return [];
  const executable = platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = [];
  for (const packageRoot of packageRoots) {
    const nativeRoots = [
      path.join(packageRoot, 'node_modules', '@openai', target.packageName),
      path.join(packageRoot, '..', target.packageName),
      packageRoot,
    ];
    for (const nativeRoot of nativeRoots) {
      const candidate = unpackedAsarPath(path.join(nativeRoot, 'vendor', target.triple, 'bin', executable));
      if (fs.existsSync(candidate)) candidates.push(candidate);
    }
  }
  return [...new Set(candidates)];
}

export function bundledCodexBinary() {
  return bundledCodexCandidates()[0] || '';
}

async function canLaunchCodex(candidate) {
  try {
    const result = await runProcess(candidate, ['--version'], {
      timeoutMs: 10_000,
      cwd: process.cwd(),
      env: process.env,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function resolveCodexBinary() {
  const explicit = process.env.JANUS_CODEX_BIN;
  if (explicit) return explicit;
  const discovered = which('codex');
  const candidates = [...bundledCodexCandidates()];
  if (discovered && !isWindowsAppsPath(discovered)) candidates.push(discovered);
  candidates.push(...localCodexCandidates());
  if (discovered && isWindowsAppsPath(discovered)) candidates.push(discovered);
  for (const candidate of candidates) {
    if (await canLaunchCodex(candidate)) return candidate;
  }
  return discovered && !isWindowsAppsPath(discovered) ? discovered : null;
}

export function codexBinaryDiagnostics() {
  const discovered = which('codex');
  const bundled = bundledCodexCandidates();
  const local = localCodexCandidates();
  return [
    `which('codex') = ${discovered || '(not found)'}`,
    'bundled Codex candidates:',
    ...(bundled.length ? bundled.map((item) => `- ${item}`) : ['- (none)']),
    'local Codex candidates:',
    ...(local.length ? local.map((item) => `- ${item}`) : ['- (none)']),
  ].join('\n');
}

function trackCodexChild(child, metadata = {}) {
  activeCodexChildren.add(child);
  activeCodexChildMetadata.set(child, {
    pid: child?.pid || 0,
    kind: String(metadata.kind || 'codex-process'),
    runId: String(metadata.runId || ''),
    startedAt: new Date().toISOString(),
  });
  const forget = () => {
    activeCodexChildren.delete(child);
    activeCodexChildMetadata.delete(child);
  };
  child.once('close', forget);
  child.once('error', forget);
  return child;
}

function codexChildExited(child) {
  return !child?.pid || child.exitCode !== null || child.signalCode !== null;
}

function codexChildTreeExited(child) {
  if (!child?.pid) return true;
  if (process.platform === 'win32') return codexChildExited(child);
  try {
    process.kill(-child.pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

const CODEX_CLOSE_STAGE_TIMEOUT_MS = 1_000;

function waitForCodexChildClose(child, timeoutMs = 2_000) {
  if (codexChildTreeExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let timer = null;
    const check = () => {
      if (codexChildTreeExited(child)) {
        if (timer) clearTimeout(timer);
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= Math.max(1, timeoutMs)) {
        resolve(false);
        return;
      }
      timer = setTimeout(check, 25);
    };
    check();
  });
}

function signalCodexChildTree(child, signal = 'SIGTERM') {
  if (codexChildTreeExited(child)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10_000,
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The Codex process has already exited.
    }
  }
}

function forceTerminateCodexChild(child) {
  signalCodexChildTree(child, 'SIGKILL');
}

async function closeCodexChild(child) {
  if (codexChildTreeExited(child)) return true;
  try {
    if (!child.stdin.destroyed) child.stdin.end();
  } catch {
    // Continue with process termination below.
  }
  if (await waitForCodexChildClose(child, CODEX_CLOSE_STAGE_TIMEOUT_MS)) return true;
  signalCodexChildTree(child, 'SIGTERM');
  if (await waitForCodexChildClose(child, CODEX_CLOSE_STAGE_TIMEOUT_MS)) return true;
  forceTerminateCodexChild(child);
  return waitForCodexChildClose(child, CODEX_CLOSE_STAGE_TIMEOUT_MS);
}

function codexAbortError(message = 'Codex execution was cancelled.') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

const CODEX_TEMP_CLEANUP_DELAYS_MS = [1_000, 5_000, 15_000];

async function removeTemporaryCodexHome(tempHome, { backgroundAttempt = 0 } = {}) {
  try {
    await fs.promises.rm(tempHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    return true;
  } catch (error) {
    const delayMs = CODEX_TEMP_CLEANUP_DELAYS_MS[backgroundAttempt];
    if (delayMs != null) {
      const timer = setTimeout(() => {
        removeTemporaryCodexHome(tempHome, { backgroundAttempt: backgroundAttempt + 1 }).catch(() => {});
      }, delayMs);
      timer.unref?.();
    } else {
      codexLogger.warn('temporary-codex-home-cleanup-failed', { error });
    }
    return false;
  }
}

export function terminateActiveCodexProcesses() {
  let terminated = 0;
  for (const child of [...activeCodexChildren]) {
    activeCodexChildren.delete(child);
    activeCodexChildMetadata.delete(child);
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) continue;
    terminated += 1;
    forceTerminateCodexChild(child);
  }
  return terminated;
}

export function activeCodexProcessSnapshot() {
  return [...activeCodexChildren].map((child) => ({
    ...(activeCodexChildMetadata.get(child) || {}),
    pid: child?.pid || activeCodexChildMetadata.get(child)?.pid || 0,
    exited: codexChildExited(child),
  }));
}

export function codexEnv(root, codexHome = null) {
  const env = { ...process.env };
  if (codexHome) env.CODEX_HOME = codexHome;
  Object.assign(env, loadAuthEnv(root));
  for (const [key, value] of Object.entries(resolvedCodexProxyEnv)) {
    const lowerKey = key.toLowerCase();
    if (!String(env[key] || env[lowerKey] || '').trim()) {
      env[key] = value;
      env[lowerKey] = value;
    }
  }
  if (process.platform === 'win32' && !String(env.SSL_CERT_FILE || '').trim()) {
    const tlsBundle = ensureCodexTlsBundle(root);
    if (tlsBundle) env.SSL_CERT_FILE = tlsBundle;
  }
  if (!env.TERM || env.TERM === 'dumb') env.TERM = 'xterm-256color';
  return env;
}

export function codexProxyEnvFromElectron(proxyRules = '') {
  const directives = String(proxyRules || '').split(';').map((item) => item.trim()).filter(Boolean);
  for (const directive of directives) {
    const separator = directive.indexOf(' ');
    const type = (separator === -1 ? directive : directive.slice(0, separator)).trim().toUpperCase();
    const endpoint = separator === -1 ? '' : directive.slice(separator + 1).trim();
    if (!endpoint || type === 'DIRECT') continue;
    let scheme = '';
    if (type === 'PROXY' || type === 'HTTP') scheme = 'http';
    else if (type === 'HTTPS') scheme = 'https';
    else if (['SOCKS', 'SOCKS5'].includes(type)) scheme = 'socks5';
    else if (type === 'SOCKS4') scheme = 'socks4';
    if (!scheme) continue;
    const proxyUrl = `${scheme}://${endpoint}`;
    try {
      const parsed = new URL(proxyUrl);
      if (!parsed.hostname || !parsed.port) continue;
    } catch {
      continue;
    }
    const noProxy = 'localhost,127.0.0.1,::1';
    if (scheme.startsWith('socks')) return { ALL_PROXY: proxyUrl, NO_PROXY: noProxy };
    return { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: noProxy };
  }
  return {};
}

export function configureCodexSystemProxy(proxyRules = '') {
  resolvedCodexProxyEnv = codexProxyEnvFromElectron(proxyRules);
  return { ...resolvedCodexProxyEnv };
}

export function configureCodexProviderRelay(relayUrl = '', error = '') {
  const cleanUrl = String(relayUrl || '').trim().replace(/\/+$/, '');
  codexProviderRelayUrl = /^http:\/\/127\.0\.0\.1:\d+$/.test(cleanUrl) ? cleanUrl : '';
  codexProviderRelayError = codexProviderRelayUrl ? '' : String(error || '').trim();
  return codexProviderRelayUrl;
}

export function codexProviderRelayStatus() {
  return {
    enabled: Boolean(codexProviderRelayUrl),
    url: codexProviderRelayUrl,
    error: codexProviderRelayError,
  };
}

export function codexProviderRelayArgs(root, relayUrl = codexProviderRelayUrl) {
  const cleanRelayUrl = String(relayUrl || '').trim().replace(/\/+$/, '');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cleanRelayUrl)) return [];
  const providerName = String(codexConfigStatus(root).providerName || '').trim();
  if (!providerName) return [];
  const providerKey = /^[A-Za-z0-9_-]+$/.test(providerName) ? providerName : JSON.stringify(providerName);
  return ['--config', `model_providers.${providerKey}.base_url=${JSON.stringify(cleanRelayUrl)}`];
}

export function codexProviderConfigForRuntime(text, relayUrl = codexProviderRelayUrl) {
  const cleanRelayUrl = String(relayUrl || '').trim().replace(/\/+$/, '');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cleanRelayUrl)) return String(text || '');
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const providerMatch = lines.map((line) => line.match(/^\s*model_provider\s*=\s*["']([^"']+)["']\s*$/)).find(Boolean);
  const providerName = String(providerMatch?.[1] || '').trim();
  if (!providerName) return String(text || '');
  let inProviderSection = false;
  let replaced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const sectionMatch = lines[index].trim().match(/^\[model_providers\.([^\]]+)\]$/);
    if (sectionMatch) {
      const sectionName = sectionMatch[1].trim().replace(/^["']|["']$/g, '');
      inProviderSection = sectionName === providerName;
      continue;
    }
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      inProviderSection = false;
      continue;
    }
    if (inProviderSection && /^\s*base_url\s*=/.test(lines[index])) {
      lines[index] = `base_url = ${JSON.stringify(cleanRelayUrl)}`;
      replaced = true;
      break;
    }
  }
  return replaced ? lines.join('\n') : String(text || '');
}

export function ensureCodexTlsBundle(root, {
  platform = process.platform,
  rootCertificates = tls.rootCertificates,
  systemCertificates = null,
} = {}) {
  if (platform !== 'win32') return '';
  let systemRoots = systemCertificates;
  if (!Array.isArray(systemRoots)) {
    try {
      systemRoots = typeof tls.getCACertificates === 'function' ? tls.getCACertificates('system') : [];
    } catch {
      systemRoots = [];
    }
  }
  const certificates = [...new Set([
    ...(Array.isArray(rootCertificates) ? rootCertificates : []),
    ...(Array.isArray(systemRoots) ? systemRoots : []),
  ].map((certificate) => String(certificate || '').trim()).filter(Boolean))];
  if (!certificates.length) return '';
  const bundleDir = path.join(tmpDir(root), 'codex-trust');
  const bundlePath = path.join(bundleDir, 'ca-bundle.pem');
  const bundle = `${certificates.join('\n')}\n`;
  fs.mkdirSync(bundleDir, { recursive: true });
  if (readText(bundlePath, '') !== bundle) fs.writeFileSync(bundlePath, bundle, 'utf8');
  return bundlePath;
}

export async function ensureSharedCodexMemories(root, codexHome) {
  const sharedDir = codexMemoriesDir(root);
  const homeMemories = path.join(codexHome, 'memories');
  await ensureDir(sharedDir);
  let stat = null;
  try {
    stat = await fs.promises.lstat(homeMemories);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat?.isSymbolicLink()) {
    const resolved = await fs.promises.realpath(homeMemories).catch(() => '');
    const expected = await fs.promises.realpath(sharedDir);
    if (resolved === expected) return sharedDir;
    await fs.promises.rm(homeMemories, { force: true });
    stat = null;
  }
  if (stat) {
    if (!stat.isDirectory()) throw new Error(`Codex memories path is not a directory: ${homeMemories}`);
    await fs.promises.cp(homeMemories, sharedDir, { recursive: true, force: false, errorOnExist: false });
    await fs.promises.rm(homeMemories, { recursive: true, force: true });
  }
  await fs.promises.symlink(sharedDir, homeMemories, process.platform === 'win32' ? 'junction' : 'dir');
  return sharedDir;
}

export async function prepareCodexHome(root, codexHome, {
  useMemories = true,
  generateMemories = false,
  isolatedPrivateSession = false,
  nativeMultiAgentEnabled = true,
  attachedSkills = [],
  targetAgentId = '',
  nativePluginUserId = '',
} = {}) {
  if (!codexHome) return;
  await ensureDir(codexHome);
  sharedConfigArgs(root);
  const memoryConfig = codexMemoryConfig(codexConfigTextForRuntime(root), {
    useMemories,
    generateMemories,
  });
  let sessionConfig = codexProviderConfigForRuntime(codexMultiAgentConfig(
    isolatedPrivateSession ? codexPrivateSessionConfig(memoryConfig) : memoryConfig,
    isolatedPrivateSession ? false : nativeMultiAgentEnabled,
  ));
  const nativePlugins = nativePluginAccountState(root, nativePluginUserId);
  if (nativePlugins.home) {
    sessionConfig += nativePluginConfigOverlay(nativePlugins.pluginIds, nativePlugins.marketplaces);
    await linkNativePluginCache(codexHome, nativePlugins.home);
  }
  await fs.promises.writeFile(path.join(codexHome, 'config.toml'), sessionConfig, 'utf8');
  const credentialSource = codexConfigStatus(root).credentialSource;
  if (['embedded', 'development'].includes(credentialSource)) {
    await fs.promises.writeFile(path.join(codexHome, 'auth.json'), '{}\n', 'utf8');
  } else {
    await fs.promises.copyFile(sharedAuthPath(root), path.join(codexHome, 'auth.json'));
  }
  await ensureSharedCodexMemories(root, codexHome);
  writeCodexAgentHarness(root, codexHome, { attachedSkills, targetAgentId });
}

function attachedSkillsForExecution(executionContext = null) {
  const store = executionContext?.store;
  const userId = String(executionContext?.userId || '').trim();
  if (!store?.resolveAttachedSkills || !userId) return [];
  return store.resolveAttachedSkills({
    ownerUserId: userId,
    departmentId: String(executionContext?.departmentId || ''),
    agentFamilyId: String(executionContext?.agentId || ''),
    agentInstanceId: String(executionContext?.agentInstanceId || ''),
  });
}

export function codexSessionCommand({
  codexBin,
  root,
  cwd = root,
  outputPath,
  threadId = '',
  sandbox = DEFAULT_CODEX_SANDBOX,
  model = '',
  reasoningEffort = '',
}) {
  const relayArgs = codexProviderRelayArgs(root);
  const overrideArgs = [];
  if (model) overrideArgs.push('--model', model);
  if (reasoningEffort) {
    overrideArgs.push('--config', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  }
  if (threadId) {
    const cmd = [
      codexBin,
      ...(sandbox === 'danger-full-access'
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['--ask-for-approval', 'never']),
      '--cd',
      cwd,
      ...(sandbox === 'danger-full-access' ? [] : ['--sandbox', sandbox]),
      ...relayArgs,
      'exec',
      'resume',
      ...overrideArgs,
      '--skip-git-repo-check',
      '--json',
      '--output-last-message',
      outputPath,
      threadId,
      '-',
    ];
    return cmd;
  }
  return [
    codexBin,
    ...(sandbox === 'danger-full-access'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--ask-for-approval', 'never']),
    ...relayArgs,
    'exec',
    ...overrideArgs,
    '--cd',
    cwd,
    ...(sandbox === 'danger-full-access' ? [] : ['--sandbox', sandbox]),
    '--skip-git-repo-check',
    '--json',
    '--output-last-message',
    outputPath,
    '-',
  ];
}

export function codexExecCommand({
  codexBin,
  root,
  cwd = root,
  outputPath,
  sandbox = DEFAULT_CODEX_SANDBOX,
  model = '',
  reasoningEffort = '',
  json = false,
}) {
  const relayArgs = codexProviderRelayArgs(root);
  const overrideArgs = [];
  if (model) overrideArgs.push('--model', model);
  if (reasoningEffort) overrideArgs.push('--config', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  return [
    codexBin,
    ...(sandbox === 'danger-full-access'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--ask-for-approval', 'never']),
    ...relayArgs,
    'exec',
    ...overrideArgs,
    '--cd',
    cwd,
    ...(sandbox === 'danger-full-access' ? [] : ['--sandbox', sandbox]),
    '--skip-git-repo-check',
    '--ephemeral',
    '--color',
    'never',
    ...(json ? ['--json'] : []),
    '--output-last-message',
    outputPath,
    '-',
  ];
}


async function runCodexAppServerTurn({
  codexBin,
  root,
  cwd = root,
  codexHome,
  prompt,
  freshPrompt = prompt,
  threadId = '',
  model = '',
  reasoningEffort = '',
  permission,
  ephemeral = false,
  timeoutMs = 0,
  signal = null,
  onEvent = null,
  onApproval = null,
  onUserInput = null,
  onTurnControlReady = null,
  dynamicTools = [],
  onDynamicToolCall = null,
  interactionMode = '',
  goalObjective = '',
  replaceGoal = false,
  memoryGenerateEnabled = false,
}) {
  const snapshotRunId = newId('codex_file_snapshot');
  const fileSnapshotPromise = createFileChangeSnapshotRunAsync({ root, cwd, runId: snapshotRunId, signal });
  let fileSnapshotRun;
  let compatibleArgs;
  try {
    [fileSnapshotRun, compatibleArgs] = await Promise.all([
      fileSnapshotPromise,
      compatibleAppServerArgs(codexBin),
    ]);
  } catch (error) {
    void fileSnapshotPromise.then((abandonedRun) => abandonedRun?.close?.()).catch(() => {});
    throw error;
  }
  recordCodexDiagnostic('file-baseline-captured', {
    runId: snapshotRunId,
    mode: fileSnapshotRun.baselineMode || 'sync',
    durationMs: Number(fileSnapshotRun.baselineDurationMs || 0),
    fileCount: Number(fileSnapshotRun.baselineFileCount || 0),
    bytes: Number(fileSnapshotRun.baselineBytes || 0),
    coverage: fileSnapshotRun.coverage,
  });
  const appServerArgs = [...codexProviderRelayArgs(root), ...compatibleArgs];
  return new Promise((resolve, reject) => {
    const diagnosticStartedAt = Date.now();
    const child = trackCodexChild(spawn(codexBin, appServerArgs, {
      cwd,
      env: codexEnv(root, codexHome),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(codexBin),
    }), { kind: 'app-server-turn', runId: snapshotRunId });
    recordCodexDiagnostic('app-server-start', {
      pid: child.pid, mode: 'app-server', model, reasoningEffort, ephemeral,
      hasThreadId: Boolean(threadId), timeoutMs, permissionMode: permission?.sandbox || permission?.mode || '',
    });
    const pending = new Map();
    const itemPhases = new Map();
    let requestId = 0;
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    let activeThreadId = threadId;
    let resumedExistingThread = false;
    let finalAnswer = '';
    let streamedAnswer = '';
    let timer = null;
    let retryTimer = null;
    let firstModelResponseTimer = null;
    let modelResponseObserved = false;
    let firstModelResponseWaitCycles = 0;
    let windowsSetupWaiter = null;
    let goal = null;
    let latestPlan = null;
    let latestPlanItemText = '';
    let tokenUsage = null;
    let effectiveModel = model;
    let activeTurnId = '';
    let publishedTurnControlKey = '';
    let turnAttempt = 0;
    let retryStarting = false;
    const tokenUsageByTurn = new Map();
    const threadUsageByTurn = new Map();
    const responseUsageByTurn = new Map();
    const recordedResponseIds = new Set();
    const generatedImagePaths = [];
    const imageToolTimers = new Map();
    const commandOutputBuffers = new Map();
    const reasoningSummaryBuffers = new Map();
    const agentMessageBuffers = new Map();
    let notificationSequence = 0;
    let finalizePendingSnapshots = () => {};

    let settling = false;

    const usageEventsSnapshot = (statusOverride = '') => [...tokenUsageByTurn.values()].map((event) => (
      statusOverride ? { ...event, status: statusOverride } : event
    ));
    const usageTurnKey = (usageThreadId = '', usageTurnId = '') => `${String(usageThreadId || activeThreadId || '')}\u001f${String(usageTurnId || activeTurnId || `attempt-${turnAttempt || 1}`)}`;
    const rememberTurnUsage = ({ usage = null, threadId: usageThreadId = '', turnId: usageTurnId = '', status = 'completed' } = {}) => {
      const normalized = codexTokenUsage(usage || {});
      if (!normalized) return null;
      const resolvedThreadId = String(usageThreadId || activeThreadId || '');
      const resolvedTurnId = String(usageTurnId || activeTurnId || `attempt-${turnAttempt || 1}`);
      const key = usageTurnKey(resolvedThreadId, resolvedTurnId);
      const threadEvent = {
        threadId: resolvedThreadId,
        turnId: resolvedTurnId,
        usage: normalized,
        usageKind: 'thread_cumulative',
        status,
        resumedExistingThread,
        model: effectiveModel,
      };
      threadUsageByTurn.set(key, threadEvent);
      const responseEvent = responseUsageByTurn.get(key);
      tokenUsageByTurn.set(key, responseEvent
        ? { ...responseEvent, cursorUsage: normalized, status, model: effectiveModel }
        : threadEvent);
      tokenUsage = normalized;
      return tokenUsageByTurn.get(key);
    };
    const rememberResponseUsage = ({ usage = null, responseId = '', threadId: usageThreadId = '', turnId: usageTurnId = '', status = 'running' } = {}) => {
      const normalized = codexTokenUsage(usage || {});
      if (!normalized) return null;
      const resolvedThreadId = String(usageThreadId || activeThreadId || '');
      const resolvedTurnId = String(usageTurnId || activeTurnId || `attempt-${turnAttempt || 1}`);
      const key = usageTurnKey(resolvedThreadId, resolvedTurnId);
      const responseKey = `${key}\u001f${String(responseId || '')}`;
      if (responseId && recordedResponseIds.has(responseKey)) return responseUsageByTurn.get(key) || null;
      if (responseId) recordedResponseIds.add(responseKey);
      const previous = responseUsageByTurn.get(key)?.usage || null;
      const aggregate = addCodexTokenUsage(previous, normalized);
      const event = {
        threadId: resolvedThreadId,
        turnId: resolvedTurnId,
        usage: aggregate,
        usageKind: 'turn',
        cursorUsage: threadUsageByTurn.get(key)?.usage || null,
        status,
        resumedExistingThread,
        model: effectiveModel,
        usageSource: 'provider_response',
      };
      responseUsageByTurn.set(key, event);
      tokenUsageByTurn.set(key, event);
      return event;
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
      if (firstModelResponseTimer) clearTimeout(firstModelResponseTimer);
      for (const imageTimer of imageToolTimers.values()) clearTimeout(imageTimer);
      imageToolTimers.clear();
      if (signal) signal.removeEventListener('abort', abortHandler);
      try { onTurnControlReady?.(null); } catch {}
    };
    const finish = (error, result = null) => {
      if (settled || settling) return;
      settling = true;
      cleanup();
      for (const waiter of pending.values()) waiter.reject(error || new Error('Codex app-server closed.'));
      pending.clear();
      if (windowsSetupWaiter) windowsSetupWaiter.reject(error || new Error('Codex app-server closed during Windows sandbox setup.'));
      void (async () => {
        try { finalizePendingSnapshots(error); } catch (snapshotError) {
          codexLogger.warn('file-snapshot-finalize-failed', { error: snapshotError });
        }
        fileSnapshotRun.close();
        const closed = await closeCodexChild(child);
        if (!closed) codexLogger.warn('app-server-forced-exit-unconfirmed', { data: { pid: child.pid } });
        settled = true;
        recordCodexDiagnostic(error ? 'app-server-failed' : 'app-server-complete', {
          pid: child.pid, closed, threadId: result?.threadId || activeThreadId || '',
          generatedImageCount: result?.generatedImagePaths?.length || 0,
        }, error ? 'error' : 'info', error, Date.now() - diagnosticStartedAt);
        if (error) {
          const unavailable = error instanceof CodexUnavailable ? error : new CodexUnavailable(error.message || String(error));
          if (error?.code && !unavailable.code) unavailable.code = error.code;
          if (error?.transientRetriesExhausted) unavailable.transientRetriesExhausted = true;
          unavailable.codexUsageEvents = usageEventsSnapshot('failed');
          unavailable.codexEffectiveModel = effectiveModel;
          reject(unavailable);
        }
        else resolve(result);
      })();
    };
    const send = (message) => {
      if (settled || settling || child.stdin.destroyed || child.stdin.writableEnded
        || child.stdin.writableFinished || !child.stdin.writable) return false;
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
        return true;
      } catch (error) {
        if (!settled && !settling) finish(error);
        return false;
      }
    };
    const request = (method, params) => new Promise((requestResolve, requestReject) => {
      const id = ++requestId;
      pending.set(String(id), { resolve: requestResolve, reject: requestReject });
      if (!send({ id, method, params })) {
        pending.delete(String(id));
        requestReject(new Error('Codex app-server transport is closed.'));
      }
    });
    const publishTurnControl = () => {
      if (!onTurnControlReady || !activeThreadId || !activeTurnId || settled || settling) return;
      const controlKey = `${activeThreadId}:${activeTurnId}`;
      if (publishedTurnControlKey === controlKey) return;
      publishedTurnControlKey = controlKey;
      onTurnControlReady({
        threadId: activeThreadId,
        turnId: activeTurnId,
        steer: async ({ text = '', clientUserMessageId = '' } = {}) => {
          const inputText = String(text || '').trim();
          if (!inputText) throw new Error('Codex steer input is required.');
          const normalizedClientUserMessageId = String(clientUserMessageId || '').trim();
          const result = await request('turn/steer', {
            threadId: activeThreadId,
            expectedTurnId: activeTurnId,
            input: [{ type: 'text', text: inputText, text_elements: [] }],
            ...(normalizedClientUserMessageId ? { clientUserMessageId: normalizedClientUserMessageId } : {}),
          });
          return { threadId: activeThreadId, turnId: String(result?.turnId || activeTurnId) };
        },
        interrupt: async () => request('turn/interrupt', { threadId: activeThreadId, turnId: activeTurnId }),
      });
    };
    const observeModelResponse = () => {
      modelResponseObserved = true;
      if (firstModelResponseTimer) clearTimeout(firstModelResponseTimer);
      firstModelResponseTimer = null;
    };
    const armFirstModelResponseTimeout = () => {
      modelResponseObserved = false;
      firstModelResponseWaitCycles = 0;
      if (firstModelResponseTimer) clearTimeout(firstModelResponseTimer);
      const responseTimeoutMs = codexAppServerFirstResponseTimeoutMs();
      const waitWindowSeconds = Number((responseTimeoutMs / 1000).toFixed(1));
      const scheduleNextWaitCycle = () => {
        firstModelResponseTimer = setTimeout(() => {
          firstModelResponseTimer = null;
          if (modelResponseObserved || settled || settling) return;
          firstModelResponseWaitCycles += 1;
          const totalWaitSeconds = Number(((responseTimeoutMs * firstModelResponseWaitCycles) / 1000).toFixed(1));
          if (firstModelResponseWaitCycles < CODEX_FIRST_RESPONSE_MAX_WAIT_CYCLES) {
            recordCodexDiagnostic('model-first-response-waiting', {
              threadId: activeThreadId || '', turnId: activeTurnId || '',
              waitCycle: firstModelResponseWaitCycles,
              maxWaitCycles: CODEX_FIRST_RESPONSE_MAX_WAIT_CYCLES,
              waitWindowMs: responseTimeoutMs,
            }, 'warn', null, responseTimeoutMs * firstModelResponseWaitCycles);
            onEvent?.({
              kind: 'activity',
              activityId: `model-first-response-waiting-${activeThreadId || turnAttempt}`,
              activityType: 'model',
              status: 'running',
              title: `模型服务响应较慢，继续等待（${firstModelResponseWaitCycles}/${CODEX_FIRST_RESPONSE_MAX_WAIT_CYCLES}）`,
              detail: `上游模型服务尚未返回输出；已等待约 ${totalWaitSeconds} 秒，Janus 将保留当前请求并继续等待响应。`,
            });
            scheduleNextWaitCycle();
            return;
          }
          const error = new Error(`Janus 已连接本地模型运行时，但上游模型服务在连续 ${CODEX_FIRST_RESPONSE_MAX_WAIT_CYCLES} 个等待周期内（每次 ${waitWindowSeconds} 秒，累计约 ${totalWaitSeconds} 秒）始终未返回任何模型输出。当前请求已停止；请检查网络或代理连接、API 配额以及模型服务状态后重试。`);
          error.code = 'codex_model_first_response_timeout';
          finish(error);
        }, responseTimeoutMs);
        firstModelResponseTimer.unref?.();
      };
      scheduleNextWaitCycle();
    };
    const startTurn = async (inputText) => {
      await waitForCodexModelCapacityCooldown({ root, model, signal });
      if (settled || settling) throw new Error('Codex app-server turn was already closed.');
      turnAttempt += 1;
      onEvent?.({
        kind: 'activity',
        activityId: `model-connection-${activeThreadId || turnAttempt}`,
        activityType: 'model',
        status: 'running',
        title: turnAttempt > 1 ? '正在重新连接模型服务' : '正在连接模型服务',
        detail: model || '默认模型',
      });
      armFirstModelResponseTimeout();
      const started = await request('turn/start', {
        threadId: activeThreadId,
        input: [{ type: 'text', text: inputText, text_elements: [] }],
        model: model || null,
        effort: reasoningEffort || null,
        summary: 'auto',
        approvalPolicy: permission.approvalPolicy,
        approvalsReviewer: permission.approvalsReviewer,
        collaborationMode: codexCollaborationMode(interactionMode, { model, reasoningEffort }),
      });
      activeTurnId = String(started?.turn?.id || started?.turnId || activeTurnId || '');
      publishTurnControl();
    };
    const respond = (id, result) => send({ id, result });
    const respondError = (id, message) => send({ id, error: { code: -32000, message } });
    const abortHandler = () => {
      const error = signal?.reason instanceof Error ? signal.reason : new Error('Codex app-server turn was cancelled.');
      finish(error);
    };
    const approvalDecision = async (message) => {
      const params = message.params || {};
      const approvalId = `${params.threadId || activeThreadId}:${params.turnId || ''}:${params.itemId || ''}:${message.id}`;
      if (permission.approvalsReviewer !== 'user') return 'decline';
      if (!onApproval) return 'decline';
      const approved = await onApproval({
        approvalId,
        itemId: params.itemId || '',
        type: message.method,
        command: params.command || '',
        cwd: params.cwd || cwd,
        reason: params.reason || '',
        grantRoot: params.grantRoot || '',
      });
      return approved ? 'accept' : 'decline';
    };
    const requestUserInput = async (message) => {
      const params = message.params || {};
      const questions = (Array.isArray(params.questions) ? params.questions : []).map((question, index) => {
        const options = Array.isArray(question?.options)
          ? question.options.map((option) => ({
              label: String(option?.label || '').trim(),
              description: String(option?.description || '').trim(),
            })).filter((option) => option.label)
          : null;
        return {
          id: String(question?.id || `question_${index + 1}`),
          header: String(question?.header || '').trim(),
          question: String(question?.question || '').trim(),
          isOther: Boolean(question?.isOther),
          isSecret: Boolean(question?.isSecret),
          options,
        };
      }).filter((question) => question.question);
      if (!questions.length) throw new Error('Codex requested user input without any valid questions.');
      if (!onUserInput) throw new Error('No user-input handler is available for this Codex turn.');
      const requestId = `${params.threadId || activeThreadId}:${params.turnId || ''}:${params.itemId || ''}:${message.id}`;
      const response = await onUserInput({
        requestId,
        threadId: params.threadId || activeThreadId,
        turnId: params.turnId || '',
        itemId: params.itemId || '',
        questions,
        autoResolutionMs: Math.max(0, Number(params.autoResolutionMs || 0)),
      });
      const sourceAnswers = response?.answers && typeof response.answers === 'object' ? response.answers : {};
      const answers = Object.fromEntries(questions.map((question) => {
        const raw = sourceAnswers[question.id];
        const values = Array.isArray(raw?.answers)
          ? raw.answers
          : Array.isArray(raw) ? raw : raw == null ? [] : [raw];
        return [question.id, {
          answers: values.map((value) => String(value || '').trim()).filter(Boolean),
        }];
      }));
      return { answers };
    };
    const handleServerRequest = async (message) => {
      observeModelResponse();
      try {
        if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
          const params = message.params || {};
          const fileApproval = message.method.includes('fileChange');
          const approvalWorkspace = String(cwd || '').replaceAll('\\', '/').replace(/\/+$/, '');
          const approvalChanges = fileApproval && Array.isArray(params.changes) ? params.changes.map((change) => {
            const filePath = String(change?.path || change?.file || '');
            const movePath = String(change?.movePath || change?.move_path || '');
            const normalizedPath = filePath.replaceAll('\\', '/');
            const normalizedMovePath = movePath.replaceAll('\\', '/');
            return {
              path: filePath,
              relativePath: approvalWorkspace && normalizedPath.toLowerCase().startsWith(`${approvalWorkspace.toLowerCase()}/`)
                ? normalizedPath.slice(approvalWorkspace.length + 1)
                : '',
              kind: normalizeCodexFileChangeKind(change),
              diff: normalizeCodexFileChangeDiff(change),
              movePath,
              moveRelativePath: approvalWorkspace && normalizedMovePath.toLowerCase().startsWith(`${approvalWorkspace.toLowerCase()}/`)
                ? normalizedMovePath.slice(approvalWorkspace.length + 1)
                : '',
            };
          }) : [];
          standaloneProtocolActivity(message, {
            activityId: 'request-' + String(message.id),
            activityType: 'approval',
            status: 'waiting',
            title: fileApproval ? '文件修改等待批准' : '命令等待批准',
            detail: String(params.command || params.reason || ''),
            approvalType: fileApproval ? 'file' : 'command',
            targetItemId: String(params.itemId || ''),
            workspaceRoot: cwd,
            changes: fileSnapshotRun.pending(approvalChanges),
            snapshotCoverage: fileSnapshotRun.coverage,
          });
          const decision = await approvalDecision(message);
          respond(message.id, { decision });
          return;
        }
        if (message.method === 'item/permissions/requestApproval') {
          const params = message.params || {};
          standaloneProtocolActivity(message, {
            activityId: 'approval-' + String(params.itemId || message.id),
            activityType: 'approval',
            status: 'waiting',
            title: '权限请求等待批准',
            detail: String(params.reason || ''),
            permissions: params.permissions || {},
          });
          const approved = await approvalDecision(message);
          if (approved === 'accept') {
            respond(message.id, { permissions: params.permissions || {}, scope: 'turn' });
          } else {
            respondError(message.id, 'User declined the requested permissions.');
          }
          return;
        }
        if (message.method === 'item/tool/requestUserInput') {
          standaloneProtocolActivity(message, {
            activityId: 'user-input-' + String(message.params?.itemId || message.id),
            activityType: 'input',
            status: 'waiting',
            title: 'Codex 请求用户输入',
            detail: (Array.isArray(message.params?.questions) ? message.params.questions : [])
              .map((question) => String(question?.question || ''))
              .filter(Boolean)
              .join('\n'),
            questions: message.params?.questions || [],
          });
          const result = await requestUserInput(message);
          respond(message.id, result);
          return;
        }
        if (message.method === 'item/tool/call') {
          const params = message.params || {};
          standaloneProtocolActivity(message, {
            activityId: 'dynamic-tool-' + String(params.callId || message.id),
            activityType: 'tool',
            status: 'running',
            title: '正在调用 Janus 工具',
            detail: [params.namespace, params.tool].filter(Boolean).join(' / '),
            toolServer: String(params.namespace || ''),
            toolName: String(params.tool || ''),
            arguments: sanitizeProcessProtocolValue(params.arguments),
          });
          if (!onDynamicToolCall) {
            respond(message.id, dynamicToolFailure('No Janus dynamic-tool handler is available.'));
            return;
          }
          let result;
          try {
            result = await onDynamicToolCall({
              namespace: String(params.namespace || ''),
              tool: String(params.tool || ''),
              arguments: params.arguments,
              callId: String(params.callId || ''),
              threadId: String(params.threadId || activeThreadId || ''),
              turnId: String(params.turnId || ''),
            });
          } catch (error) {
            result = dynamicToolFailure(error?.message || String(error));
          }
          respond(message.id, normalizeDynamicToolResult(result));
          return;
        }
        if (message.method === 'currentTime/read') {
          standaloneProtocolActivity(message, {
            activityId: 'current-time-' + String(message.id),
            activityType: 'tool',
            status: 'completed',
            title: '读取当前时间',
            detail: '',
          });
          respond(message.id, { currentTime: new Date().toISOString() });
          return;
        }
        standaloneProtocolActivity(message, {
          activityId: 'unsupported-request-' + String(message.id),
          activityType: 'protocol',
          status: 'failed',
          title: '未支持的 Codex 请求',
          detail: String(message.method || ''),
        });
        respondError(message.id, `Unsupported app-server request: ${message.method}`);
      } catch (error) {
        respondError(message.id, error.message || String(error));
      }
    };
    const emitFinalCorrection = (answer) => {
      const text = stripProcessSummary(answer || '');
      if (!text || !onEvent || text === streamedAnswer) return;
      if (!streamedAnswer) {
        streamedAnswer = text;
        onEvent({ kind: 'answer', content: text });
      } else if (text.startsWith(streamedAnswer)) {
        const content = text.slice(streamedAnswer.length);
        streamedAnswer = text;
        if (content) onEvent({ kind: 'token', content });
      } else {
        streamedAnswer = text;
        onEvent({ kind: 'answer', content: text });
      }
    };
    const emitNativeActivity = (event, message) => {
      if (!event) return null;
      const params = message?.params || {};
      const item = params.item || {};
      const sequence = ++notificationSequence;
      const receivedAtMs = Date.now();
      const emittedAt = Number(message?.emittedAtMs ?? message?.emitted_at_ms);
      const emittedAtMs = Number.isFinite(emittedAt) ? emittedAt : null;
      const protocolThreadId = String(event.threadId || params.threadId || activeThreadId || '');
      const protocolTurnId = String(event.turnId || params.turnId || '');
      const protocolItemId = String(event.itemId || params.itemId || item.id || event.activityId || '');
      const nativeEvent = {
        ...event,
        eventOrigin: event.eventOrigin || 'codex',
        nativeSource: 'codex_app_server',
        threadId: protocolThreadId,
        turnId: protocolTurnId,
        itemId: protocolItemId,
        itemType: String(event.itemType || item.type || ''),
        protocolEvents: [{
          protocolEventId: [protocolThreadId, protocolTurnId, protocolItemId, String(event.protocolMethod || message?.method || ''), emittedAtMs ?? '', receivedAtMs, sequence].join(':'),
          sequence,
          emittedAtMs,
          receivedAtMs,
          requestId: message?.id == null ? null : String(message.id),
          threadId: protocolThreadId,
          turnId: protocolTurnId,
          itemId: protocolItemId,
          direction: String(event.protocolDirection || 'server'),
          method: String(event.protocolMethod || message?.method || ''),
          params: sanitizeProcessProtocolValue(params),
          envelope: sanitizeProcessProtocolValue(message),
        }],
      };
      onEvent?.(nativeEvent);
      return nativeEvent;
    };
    finalizePendingSnapshots = (error = null) => {
      for (const pendingSnapshot of fileSnapshotRun.finalizePending()) {
        onEvent?.({
          kind: 'activity',
          activityId: pendingSnapshot.activityId,
          activityType: 'file',
          status: error ? 'failed' : 'completed',
          title: error ? '文件比较在中断后完成' : '文件比较已完成',
          detail: error ? '执行中断后，Janus 根据 turn 开始时的基线完成了本地严格对照。' : 'Janus 已完成本地严格对照。',
          changes: pendingSnapshot.changes,
          workspaceRoot: cwd,
          eventOrigin: 'codex',
          nativeSource: 'codex_app_server',
          nativeChangeSource: 'codex_app_server',
          derivedSource: 'janus_turn_snapshot',
          snapshotFinalization: true,
          snapshotCoverage: fileSnapshotRun.coverage,
        });
      }
    };
    const reasoningSummarySnapshot = (itemId = '') => {
      const parts = reasoningSummaryBuffers.get(String(itemId || '')) || new Map();
      return [...parts.entries()]
        .map(([index, text]) => ({ index: Number(index), text: String(text || '').trim() }))
        .filter((part) => part.text)
        .sort((left, right) => left.index - right.index);
    };
    const commentaryProjection = (text = '') => {
      const value = String(text || '');
      return {
        detail: value,
        stageOutput: false,
      };
    };
    const standaloneProtocolActivity = (message, {
      activityId = '',
      activityType = 'protocol',
      status = 'completed',
      title = 'Codex 事件',
      detail = '',
      ...extra
    } = {}) => {
      const params = message?.params || {};
      return emitNativeActivity({
        kind: 'activity',
        activityId: activityId || 'protocol-' + String(notificationSequence + 1),
        activityType,
        status,
        title,
        detail: String(detail || ''),
        ...extra,
      }, message);
    };
    const handleNotification = (message) => {
      const params = message.params || {};
      recordCodexDiagnostic('app-server-notification', {
        method: message.method || '', threadId: params.threadId || activeThreadId || '', turnId: params.turnId || '',
        itemId: params.itemId || params.item?.id || '', itemType: params.item?.type || '', status: params.turn?.status || params.item?.status || '',
      }, 'debug');
      if (message.method === 'windowsSandbox/setupCompleted' && windowsSetupWaiter) {
        standaloneProtocolActivity(message, {
          activityId: 'windows-sandbox-' + String(params.threadId || activeThreadId || ''),
          activityType: 'sandbox',
          status: params.success ? 'completed' : 'failed',
          title: params.success ? 'Windows Sandbox 已就绪' : 'Windows Sandbox 初始化失败',
          detail: String(params.error || ''),
          sandboxSetup: params,
        });
        const waiter = windowsSetupWaiter;
        windowsSetupWaiter = null;
        if (params.success) waiter.resolve(params);
        else waiter.reject(new Error(params.error || 'Windows sandbox setup failed.'));
        return;
      }
      if (message.method === 'item/started' && params.item?.id) {
        const startedItemType = String(params.item?.type || '').replaceAll('_', '').toLowerCase();
        if (startedItemType !== 'usermessage') observeModelResponse();
        itemPhases.set(params.item.id, params.item.phase || '');
        if (params.item.type === 'agentMessage') agentMessageBuffers.set(params.item.id, String(params.item.text || ''));
        if (codexItemType(params.item) === 'imagegeneration') {
          clearCodexImageToolTimer(imageToolTimers, params.item.id);
          const imageTimeoutMs = codexImageToolTimeoutMs();
          const imageTimer = setTimeout(() => {
            imageToolTimers.delete(params.item.id);
            finish(new Error(`图片生成工具超过 ${Math.ceil(imageTimeoutMs / 1000)} 秒仍未完成；已停止本次执行，请重试。`));
          }, imageTimeoutMs);
          imageToolTimers.set(params.item.id, imageTimer);
        }
        const processEvent = codexProcessEventForItem(params.item, {
          status: 'running',
          startedAtMs: params.startedAtMs,
        });
        if (processEvent) emitNativeActivity(processEvent, message);
        else standaloneProtocolActivity(message, {
          activityId: String(params.item.id),
          activityType: 'protocol',
          status: 'running',
          title: String(params.item.type || 'Codex 项目已开始'),
          itemType: String(params.item.type || ''),
        });
        return;
      }
      if (message.method === 'item/commandExecution/outputDelta') {
        if (params.delta) {
          const previousOutput = commandOutputBuffers.get(params.itemId) || '';
          const bufferedOutput = previousOutput + params.delta;
          commandOutputBuffers.set(params.itemId, bufferedOutput);
          const processEvent = codexProcessEventForItem(
            { id: params.itemId, type: 'commandExecution' },
            { status: 'running', output: bufferedOutput },
          );
          emitNativeActivity(processEvent, message);
        }
        return;
      }
      if (message.method === 'item/reasoning/summaryTextDelta') {
        observeModelResponse();
        if (params.delta) {
          const itemId = String(params.itemId || '');
          const summaryIndex = Number.isInteger(params.summaryIndex) ? params.summaryIndex : 0;
          const parts = reasoningSummaryBuffers.get(itemId) || new Map();
          parts.set(summaryIndex, `${parts.get(summaryIndex) || ''}${params.delta}`);
          reasoningSummaryBuffers.set(itemId, parts);
          const summaryParts = reasoningSummarySnapshot(itemId);
          const processEvent = codexProcessEventForItem(
            { id: params.itemId, type: 'reasoning' },
            {
              status: 'running',
              detail: summaryParts.map((part) => part.text).join('\n\n'),
              summaryParts,
              summaryIndex,
            },
          );
          emitNativeActivity(processEvent, message);
        }
        return;
      }
      if (message.method === 'item/reasoning/summaryPartAdded') {
        const itemId = String(params.itemId || '');
        const summaryIndex = Number.isInteger(params.summaryIndex) ? params.summaryIndex : 0;
        const parts = reasoningSummaryBuffers.get(itemId) || new Map();
        if (!parts.has(summaryIndex)) parts.set(summaryIndex, '');
        reasoningSummaryBuffers.set(itemId, parts);
        const summaryParts = reasoningSummarySnapshot(itemId);
        const processEvent = codexProcessEventForItem(
          { id: params.itemId, type: 'reasoning' },
          { status: 'running', summaryParts, summaryIndex },
        ) || {
          kind: 'activity', activityId: String(params.itemId), activityType: 'reasoning', status: 'running',
          title: '思考摘要', detail: '', summaryParts, summaryIndex,
        };
        emitNativeActivity(processEvent, message);
        return;
      }
      if (message.method === 'item/reasoning/textDelta') {
        observeModelResponse();
        if (params.delta) {
          const processEvent = codexProcessEventForItem(
            { id: params.itemId, type: 'reasoning' },
            { status: 'running', reasoningText: params.delta, appendReasoningText: true },
          );
          emitNativeActivity(processEvent, message);
        }
        return;
      }
      if (message.method === 'item/commandExecution/terminalInteraction') {
        const processEvent = codexProcessEventForItem(
          { id: params.itemId, type: 'commandExecution', processId: params.processId },
          { status: 'running', terminalInput: params.stdin || '', appendTerminalInput: true },
        );
        emitNativeActivity(processEvent, message);
        return;
      }
      if (message.method === 'item/fileChange/patchUpdated') {
        const activityId = String(params.itemId || 'file-change');
        const changes = fileSnapshotRun.observe(activityId, params.changes || []);
        const processEvent = codexProcessEventForItem(
          { id: activityId, type: 'fileChange', changes, workspaceRoot: cwd },
          { status: 'running' },
        );
        if (processEvent) processEvent.snapshotCoverage = fileSnapshotRun.coverage;
        emitNativeActivity(processEvent, message);
        return;
      }
      if (message.method === 'turn/diff/updated') {
        standaloneProtocolActivity(message, {
          activityId: 'turn-diff-' + String(params.turnId || ''),
          activityType: 'file',
          status: 'running',
          title: '本轮文件变更',
          detail: 'Codex 已更新本轮统一 diff',
          diff: String(params.diff || ''),
        });
        return;
      }
      if (message.method === 'item/plan/delta') {
        observeModelResponse();
        if (params.delta) latestPlanItemText += params.delta;
        const processEvent = codexProcessEventForItem(
          { id: params.itemId, type: 'plan' },
          { status: 'running', detail: params.delta || '', append: true },
        );
        emitNativeActivity(processEvent, message);
        return;
      }
      if (message.method === 'item/mcpToolCall/progress') {
        const processEvent = codexProcessEventForItem(
          { id: params.itemId, type: 'mcpToolCall' },
          { status: 'running', detail: params.message || '' },
        );
        emitNativeActivity(processEvent, message);
        return;
      }
      if (message.method === 'item/agentMessage/delta') {
        observeModelResponse();
        const phase = itemPhases.get(params.itemId) || '';
        const previousText = agentMessageBuffers.get(params.itemId) || '';
        const accumulatedText = `${previousText}${params.delta || ''}`;
        agentMessageBuffers.set(params.itemId, accumulatedText);
        const commentary = phase === 'commentary' ? commentaryProjection(accumulatedText) : null;
        const processEvent = codexProcessEventForItem(
          { id: params.itemId, type: 'agentMessage', phase, text: commentary?.detail ?? params.delta ?? '' },
          {
            status: 'running',
            detail: phase === 'commentary' ? commentary.detail : phase || 'agentMessage',
            stageOutput: commentary?.stageOutput ?? false,
          },
        );
        emitNativeActivity(processEvent, message);
        if (phase === 'final_answer' && params.delta) {
          streamedAnswer += params.delta;
          onEvent?.({ kind: 'token', content: params.delta });
        }
        return;
      }
      if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
        clearCodexImageToolTimer(imageToolTimers, params.item?.id);
        const text = String(params.item.text || '').trim();
        const phase = params.item.phase || itemPhases.get(params.item.id) || '';
        const commentary = phase === 'commentary' ? commentaryProjection(text) : null;
        const processEvent = codexProcessEventForItem(
          { ...params.item, phase, ...(commentary ? { text: commentary.detail } : {}) },
          { status: 'completed', completedAtMs: params.completedAtMs, stageOutput: commentary?.stageOutput ?? false },
        );
        emitNativeActivity(processEvent, message);
        agentMessageBuffers.delete(params.item?.id);
        if (phase !== 'commentary' && text) {
          finalAnswer = text;
          emitFinalCorrection(text);
        }
        return;
      }
      if (message.method === 'item/completed') {
        if (params.item?.type === 'plan') {
          const completedPlanText = String(params.item.text || latestPlanItemText || '').trim();
          if (completedPlanText) latestPlanItemText = completedPlanText;
        }
        clearCodexImageToolTimer(imageToolTimers, params.item?.id);
        commandOutputBuffers.delete(params.item?.id);
        reasoningSummaryBuffers.delete(params.item?.id);
        agentMessageBuffers.delete(params.item?.id);
        collectCodexGeneratedImagePath(generatedImagePaths, params.item || {}, cwd, path.join(tmpDir(root), 'codex-generated-images'));
        const completedItem = String(params.item?.type || '').toLowerCase() === 'filechange'
          ? { ...params.item, workspaceRoot: cwd }
          : params.item || {};
        const processEvent = codexProcessEventForItem(completedItem, {
          status: 'completed',
          completedAtMs: params.completedAtMs,
        });
        if (processEvent?.activityType === 'file') {
          processEvent.changes = fileSnapshotRun.complete(processEvent.activityId, processEvent.changes || []);
          processEvent.snapshotCoverage = fileSnapshotRun.coverage;
          processEvent.nativeChangeSource = 'codex_app_server';
          processEvent.derivedSource = 'janus_turn_snapshot';
        }
        if (processEvent) emitNativeActivity(processEvent, message);
        else standaloneProtocolActivity(message, {
          activityId: String(params.item?.id || 'protocol-' + String(notificationSequence + 1)),
          activityType: 'protocol',
          status: 'completed',
          title: String(params.item?.type || 'Codex 项目已完成'),
          itemType: String(params.item?.type || ''),
        });
        return;
      }
      if (message.method === 'thread/compacted') {
        emitNativeActivity({
          kind: 'activity',
          activityId: `context-${params.threadId || activeThreadId}`,
          activityType: 'context',
          status: 'completed',
          title: 'Codex 已整理上下文',
          detail: 'Codex 已在当前线程中完成原生上下文压缩；Janus 将在下一轮重新确认当前运行时上下文。',
          providerCompactionDetected: true,
        }, message);
        return;
      }
      if (message.method === 'model/rerouted') {
        effectiveModel = String(params.toModel || effectiveModel || model || '');
        emitNativeActivity({
          kind: 'activity',
          activityId: `model-reroute-${params.turnId || Date.now()}`,
          activityType: 'model',
          status: 'completed',
          title: '模型路由已调整',
          detail: sanitizeProgress(params.reason || params.message || ''),
          fromModel: String(params.fromModel || ''),
          toModel: String(params.toModel || ''),
          rerouteReason: params.reason || null,
        }, message);
        return;
      }
      if (message.method === 'error') {
        standaloneProtocolActivity(message, {
          activityId: 'error-' + String(params.turnId || notificationSequence + 1),
          activityType: 'error',
          status: params.willRetry ? 'running' : 'failed',
          title: params.willRetry ? 'Codex 错误，准备重试' : 'Codex 错误',
          detail: String(params.error?.message || params.error || ''),
          error: params.error || null,
          willRetry: Boolean(params.willRetry),
        });
        return;
      }
      if (['warning', 'guardianWarning', 'configWarning', 'deprecationNotice'].includes(message.method)) {
        standaloneProtocolActivity(message, {
          activityId: 'warning-' + String(notificationSequence + 1),
          activityType: 'warning',
          status: 'completed',
          title: message.method === 'deprecationNotice' ? 'Codex 兼容性提示' : 'Codex 提示',
          detail: String(params.message || params.warning || params.detail || ''),
          warning: params,
        });
        return;
      }
      if (message.method === 'hook/started' || message.method === 'hook/completed') {
        const run = params.run || {};
        standaloneProtocolActivity(message, {
          activityId: 'hook-' + String(run.id || notificationSequence + 1),
          activityType: 'hook',
          status: message.method === 'hook/started' ? 'running' : run.status === 'failed' ? 'failed' : 'completed',
          title: message.method === 'hook/started' ? '正在运行 Hook' : 'Hook 已完成',
          detail: String(run.statusMessage || run.eventName || ''),
          hook: run,
        });
        return;
      }
      if (message.method === 'item/autoApprovalReview/started' || message.method === 'item/autoApprovalReview/completed') {
        standaloneProtocolActivity(message, {
          activityId: 'approval-review-' + String(params.reviewId || params.targetItemId || notificationSequence + 1),
          activityType: 'approval',
          status: message.method.endsWith('/started') ? 'running' : 'completed',
          title: message.method.endsWith('/started') ? '正在审查操作权限' : '操作权限审查完成',
          detail: String(params.review?.reason || params.action?.reason || ''),
          review: params.review || null,
          action: params.action || null,
          decisionSource: params.decisionSource || null,
        });
        return;
      }
      if (message.method === 'model/verification' || message.method === 'model/safetyBuffering/updated') {
        standaloneProtocolActivity(message, {
          activityId: 'model-state-' + String(params.turnId || notificationSequence + 1),
          activityType: 'model',
          status: 'completed',
          title: message.method === 'model/verification' ? '模型验证' : '模型安全缓冲状态',
          detail: String(params.message || (Array.isArray(params.reasons) ? params.reasons.join('\n') : '')),
          verifications: params.verifications || null,
          safetyBuffering: message.method === 'model/safetyBuffering/updated' ? params : null,
        });
        return;
      }
      if (message.method === 'turn/started' || message.method === 'thread/status/changed') {
        if (message.method === 'turn/started') {
          activeTurnId = String(params.turn?.id || params.turnId || activeTurnId || '');
          publishTurnControl();
        }
        standaloneProtocolActivity(message, {
          activityId: message.method === 'turn/started'
            ? 'turn-' + String(params.turn?.id || params.turnId || notificationSequence + 1)
            : 'thread-status-' + String(params.threadId || activeThreadId || ''),
          activityType: 'status',
          status: 'running',
          title: message.method === 'turn/started' ? '模型已连接，正在处理' : '模型连接状态更新',
          detail: String(params.status || params.thread?.status || ''),
        });
        return;
      }
      if (message.method === 'serverRequest/resolved') {
        standaloneProtocolActivity(message, {
          activityId: 'request-' + String(params.requestId || notificationSequence + 1),
          activityType: 'approval',
          status: 'completed',
          title: 'Codex 请求已处理',
          detail: String(params.requestId || ''),
          decision: String(params.decision || params.result?.decision || params.response?.decision || ''),
        });
        return;
      }
      if (message.method === 'rawResponseItem/completed' || message.method === 'rawResponse/completed') {
        if (message.method === 'rawResponse/completed') {
          rememberResponseUsage({
            usage: params.usage || params,
            responseId: params.responseId,
            threadId: params.threadId,
            turnId: params.turnId,
          });
        }
        standaloneProtocolActivity(message, {
          activityId: 'raw-response-' + String(params.item?.id || params.responseId || notificationSequence + 1),
          activityType: 'protocol',
          status: 'completed',
          title: message.method === 'rawResponseItem/completed' ? '模型原始响应项' : '模型原始响应完成',
          detail: String(params.item?.type || params.responseId || ''),
          rawResponse: params.item || params,
          usage: codexTokenUsage(params),
        });
        return;
      }
      if (/token.?usage/i.test(String(message.method || ''))) {
        rememberTurnUsage({
          usage: params,
          threadId: params.threadId,
          turnId: params.turnId,
          status: 'running',
        });
        standaloneProtocolActivity(message, {
          activityId: 'token-usage-' + String(params.turnId || activeThreadId || ''),
          activityType: 'usage',
          status: 'completed',
          title: 'Token 使用量',
          detail: tokenUsage ? String(tokenUsage.last?.totalTokens || tokenUsage.totalTokens || 0) + ' tokens' : '',
          usage: tokenUsage || params.tokenUsage || params.token_usage || null,
        });
        return;
      }
      if (message.method === 'turn/moderationMetadata') {
        standaloneProtocolActivity(message, {
          activityId: 'moderation-' + String(params.turnId || notificationSequence + 1),
          activityType: 'model',
          status: 'completed',
          title: '模型审核元数据',
          detail: '',
          moderationMetadata: params.metadata ?? null,
        });
        return;
      }
      if (message.method === 'turn/completed') {
        const turn = params.turn || {};
        activeTurnId = String(params.turnId || turn.id || activeTurnId || '');
        const interrupted = ['interrupted', 'cancelled', 'canceled'].includes(String(turn.status || '').toLowerCase());
        standaloneProtocolActivity(message, {
          activityId: 'turn-' + String(params.turnId || turn.id || activeThreadId || ''),
          activityType: 'status',
          status: turn.status === 'failed' ? 'failed' : interrupted ? 'cancelled' : 'completed',
          title: turn.status === 'failed' ? 'Codex 本轮执行失败' : interrupted ? 'Codex 本轮执行已中断' : 'Codex 本轮执行完成',
          detail: String(turn.error?.message || ''),
          usage: codexTokenUsage(params) || codexTokenUsage(turn),
        });
        for (const item of turn.items || []) {
          collectCodexGeneratedImagePath(generatedImagePaths, item, cwd, path.join(tmpDir(root), 'codex-generated-images'));
        }
        const completedTurnUsage = codexTokenUsage(params) || codexTokenUsage(turn);
        if (completedTurnUsage) {
          rememberTurnUsage({
            usage: completedTurnUsage,
            threadId: params.threadId || activeThreadId,
            turnId: activeTurnId,
            status: turn.status === 'failed' ? 'failed' : 'completed',
          });
        } else {
          const currentUsageKey = `${String(params.threadId || activeThreadId || '')}\u001f${activeTurnId}`;
          const currentUsage = tokenUsageByTurn.get(currentUsageKey);
          if (currentUsage) tokenUsageByTurn.set(currentUsageKey, { ...currentUsage, status: turn.status === 'failed' ? 'failed' : 'completed' });
        }
        const agentMessages = (turn.items || []).filter((item) => item?.type === 'agentMessage' && item.text);
        const final = [...agentMessages].reverse().find((item) => item.phase === 'final_answer') || agentMessages.at(-1);
        if (final?.text) finalAnswer = final.text;
        if (turn.status === 'failed') {
          const errorMessage = turn.error?.message || 'Codex app-server turn failed.';
          const maxAttempts = codexAppServerTransientMaxAttempts();
          if (isCodexModelCapacityFailure(errorMessage)) markCodexModelCapacityCooldown({ root, model });
          const canRetry = permission.approvalsReviewer === 'user'
            && isRetryableCodexTurnFailure(errorMessage)
            && turnAttempt < maxAttempts;
          if (canRetry && !retryStarting) {
            retryStarting = true;
            const nextAttempt = turnAttempt + 1;
            emitNativeActivity({
              kind: 'activity',
              activityId: `model-turn-retry-${activeThreadId}-${nextAttempt}`,
              activityType: 'model',
              status: 'completed',
              title: '模型服务自动续跑',
              detail: `模型服务暂时不可用；将在同一线程从已有阶段结果继续（第 ${nextAttempt}/${maxAttempts} 次尝试）。`,
            }, message);
            const retryDelayMs = codexAppServerTransientRetryDelayMs(turnAttempt);
            retryTimer = setTimeout(() => {
              retryTimer = null;
              retryStarting = false;
              if (settled || settling) return;
              finalAnswer = '';
              void startTurn(codexTransientContinuationPrompt()).catch((error) => finish(error));
            }, retryDelayMs);
            return;
          }
          const error = new Error(errorMessage);
          if (isRetryableCodexTurnFailure(errorMessage) && turnAttempt >= maxAttempts) error.transientRetriesExhausted = true;
          finish(error);
          return;
        }
        if (interrupted) {
          const error = new Error('Codex app-server turn was interrupted.');
          error.code = 'codex_turn_interrupted';
          finish(error);
          return;
        }
        clearCodexModelCapacityCooldown({ root, model });
        // In native Plan collaboration mode the authoritative user-facing result is a
        // completed `plan` item, not necessarily an `agentMessage`. Plan deltas are only
        // a preview and may differ from the completed item, so prefer the completed text.
        const planAnswer = interactionMode === 'plan' ? latestPlanItemText : '';
        const answer = stripProcessSummary(planAnswer || finalAnswer || streamedAnswer);
        const completedPlan = interactionMode === 'plan' && answer
          ? {
              ...(latestPlan || { explanation: '', steps: [] }),
              content: answer,
            }
          : latestPlan;
        emitFinalCorrection(answer);
        finish(null, {
          answer, threadId: activeThreadId, turnId: activeTurnId, goal, plan: completedPlan,
          usage: tokenUsage, usageEvents: usageEventsSnapshot(), generatedImagePaths, effectiveModel,
        });
        return;
      }
      if (message.method === 'turn/plan/updated') {
        latestPlan = {
          explanation: String(params.explanation || ''),
          steps: Array.isArray(params.plan) ? params.plan : [],
        };
        standaloneProtocolActivity(message, {
          activityId: 'native-plan-' + String(params.turnId || activeThreadId || ''),
          activityType: 'plan',
          status: latestPlan.steps.every((step) => step?.status === 'completed') ? 'completed' : 'running',
          title: 'Codex 执行计划',
          detail: latestPlan.explanation,
          plan: latestPlan.steps,
        });
        onEvent?.({
          kind: 'plan-update',
          explanation: latestPlan.explanation,
          plan: latestPlan.steps,
        });
        return;
      }
      if (message.method === 'thread/goal/updated') {
        goal = params.goal || goal;
        standaloneProtocolActivity(message, {
          activityId: 'goal-' + String(params.threadId || activeThreadId || ''),
          activityType: 'goal',
          status: goal?.status === 'complete' ? 'completed' : goal?.status === 'blocked' ? 'blocked' : 'running',
          title: 'Codex 目标状态',
          detail: String(goal?.objective || ''),
          goal,
        });
        onEvent?.({ kind: 'goal-update', goal });
        return;
      }
      if (message.method === 'thread/goal/cleared') {
        goal = null;
        standaloneProtocolActivity(message, {
          activityId: 'goal-' + String(params.threadId || activeThreadId || ''),
          activityType: 'goal',
          status: 'completed',
          title: 'Codex 目标已清除',
        });
        onEvent?.({ kind: 'goal-update', goal: null });
        return;
      }
      if (message.method) {
        standaloneProtocolActivity(message, {
          activityId: 'protocol-' + String(params.itemId || params.requestId || notificationSequence + 1),
          activityType: 'protocol',
          status: 'completed',
          title: String(message.method),
          detail: String(params.message || params.delta || params.status || ''),
        });
      }
    };
    const handleLine = (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const key = message.id == null ? '' : String(message.id);
      if (key && pending.has(key) && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
        standaloneProtocolActivity(message, {
          activityId: 'rpc-response-' + key,
          activityType: 'protocol',
          status: message.error ? 'failed' : 'completed',
          title: message.error ? 'Codex RPC 错误响应' : 'Codex RPC 响应',
          detail: String(message.error?.message || ''),
          protocolMethod: 'rpc/response',
          protocolDirection: 'server',
          threadId: String(message.result?.thread?.id || activeThreadId || ''),
          turnId: String(message.result?.turn?.id || ''),
          rpcResult: message.result ?? null,
          rpcError: message.error ?? null,
        });
        const waiter = pending.get(key);
        pending.delete(key);
        if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else waiter.resolve(message.result);
        return;
      }
      if (key && message.method) {
        handleServerRequest(message);
        return;
      }
      if (message.method) handleNotification(message);
    };

    child.on('error', (error) => finish(error));
    child.stdin.on('error', (error) => {
      if (!settled && !settling) finish(error);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) if (line.trim()) handleLine(line.trim());
    });
    child.on('close', (code) => {
      if (!settled && !settling) finish(new Error(`Codex app-server exited with code ${code ?? 0}: ${stderr.trim()}`));
    });
    if (signal) {
      if (signal.aborted) return abortHandler();
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    if (timeoutMs > 0) timer = setTimeout(() => finish(new Error(`Codex app-server timed out after ${timeoutMs}ms.`)), timeoutMs);

    (async () => {
      try {
        await request('initialize', {
          clientInfo: { name: 'janus', title: 'Janus Desktop', version: JANUS_CLIENT_VERSION },
          capabilities: { experimentalApi: true, requestAttestation: false },
        });
        send({ method: 'initialized' });
        if (process.platform === 'win32' && permission.sandbox === 'workspace-write') {
          try {
            const readiness = await ensureWindowsSandboxReady({
              request,
              cwd,
              createSetupWaiter: () => {
                const promise = new Promise((setupResolve, setupReject) => {
                  const setupTimer = setTimeout(() => setupReject(new Error('Windows sandbox setup timed out.')), 120_000);
                  windowsSetupWaiter = {
                    resolve: (value) => { clearTimeout(setupTimer); setupResolve(value); },
                    reject: (error) => { clearTimeout(setupTimer); setupReject(error); },
                  };
                });
                return {
                  promise,
                  cancel() {
                    windowsSetupWaiter?.resolve({ skipped: true });
                    windowsSetupWaiter = null;
                  },
                };
              },
            });
            recordCodexDiagnostic('windows-sandbox-ready', {
              mode: 'app-server', cwd, sandbox: permission.sandbox,
              readinessSupported: readiness.readinessSupported,
              setupStarted: readiness.setupStarted, status: readiness.status,
            });
          } catch (error) {
            recordCodexDiagnostic('windows-sandbox-unavailable', {
              mode: 'app-server', cwd, sandbox: permission.sandbox,
              error: String(error?.message || error), errorCode: String(error?.code || ''),
            });
            throw error;
          }
        }
        const threadParams = {
          model: model || null,
          cwd,
          approvalPolicy: permission.approvalPolicy,
          approvalsReviewer: permission.approvalsReviewer,
          sandbox: permission.sandbox,
        };
        const threadStartParams = {
          ...threadParams,
          ...(Array.isArray(dynamicTools) && dynamicTools.length ? { dynamicTools } : {}),
          ephemeral,
        };
        let threadResult;
        if (threadId) {
          try {
            threadResult = await request('thread/resume', { threadId, ...threadParams });
            resumedExistingThread = true;
          } catch {
            threadResult = await request('thread/start', threadStartParams);
          }
        } else {
          threadResult = await request('thread/start', threadStartParams);
        }
        activeThreadId = threadResult?.thread?.id || threadId;
        const supportsThreadMetadata = codexThreadSupportsMetadataUpdates({ ephemeral });
        if (supportsThreadMetadata) await setCodexThreadMemoryMode(request, activeThreadId, memoryGenerateEnabled);
        if (supportsThreadMetadata && interactionMode === 'goal') {
          try {
            const current = await request('thread/goal/get', { threadId: activeThreadId });
            goal = current?.goal || null;
            const objective = String(goalObjective || '').trim().slice(0, 4000);
            const shouldSetGoal = objective && (!goal || replaceGoal);
            const shouldClearLegacyBudget = Number(goal?.tokenBudget ?? goal?.token_budget ?? 0) > 0;
            if (shouldSetGoal || shouldClearLegacyBudget) {
              const updated = await request('thread/goal/set', {
                threadId: activeThreadId,
                objective: shouldSetGoal ? objective : String(goal.objective || objective).slice(0, 4000),
                status: shouldSetGoal ? 'active' : goal.status || 'active',
                tokenBudget: null,
              });
              goal = updated?.goal || null;
              onEvent?.({ kind: 'goal-update', goal });
            }
          } catch (error) {
            if (!isUnsupportedAppServerMethod(error, 'thread/goal')) throw error;
          }
        } else if (supportsThreadMetadata) {
          try {
            const current = await request('thread/goal/get', { threadId: activeThreadId });
            if (current?.goal) await request('thread/goal/clear', { threadId: activeThreadId });
          } catch (error) {
            if (!isUnsupportedAppServerMethod(error, 'thread/goal')) throw error;
          }
        }
        await startTurn(resumedExistingThread ? prompt : freshPrompt);
      } catch (error) {
        finish(new Error(`Codex app-server could not start the turn: ${error.message || error}`));
      }
    })();
  });
}

function codexAppServerTransientMaxAttempts() {
  return Math.max(1, Math.min(3, Number(process.env.JANUS_APP_SERVER_TRANSIENT_MAX_ATTEMPTS || 3)));
}

function codexAppServerTransientRetryDelayMs(completedAttempt = 1) {
  const base = Math.max(0, Math.min(10_000, Number(process.env.JANUS_APP_SERVER_TRANSIENT_RETRY_BASE_MS || 1200)));
  return base * (2 ** Math.max(0, Number(completedAttempt || 1) - 1));
}

function isRetryableCodexTurnFailure(message = '') {
  return /overloaded|at capacity|capacity.{0,48}(?:try|different model)|service unavailable|temporarily unavailable|bad gateway|gateway timeout|rate.?limit|too many requests|resource exhausted|\b(?:429|502|503|504)\b|\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b|network error|socket hang up|fetch failed|connection closed/i
    .test(String(message || ''));
}

function isCodexModelCapacityFailure(message = '') {
  return /overloaded|at capacity|capacity.{0,48}(?:try|different model)|service unavailable|temporarily unavailable|rate.?limit|too many requests|resource exhausted|\b(?:429|503)\b/i
    .test(String(message || ''));
}

function codexModelCapacityKey({ root = '', model = '' } = {}) {
  const config = codexConfigStatus(root);
  return `${String(config.providerName || '')}\u0000${String(config.baseUrl || '')}\u0000${String(model || config.model || '')}`;
}

function markCodexModelCapacityCooldown({ root = '', model = '' } = {}) {
  const key = codexModelCapacityKey({ root, model });
  const cooldownMs = Math.max(0, Math.min(30_000, Number(process.env.JANUS_MODEL_CAPACITY_COOLDOWN_MS || 3000)));
  const until = Date.now() + cooldownMs;
  codexModelCapacityCooldowns.set(key, Math.max(until, Number(codexModelCapacityCooldowns.get(key) || 0)));
  if (codexModelCapacityCooldowns.size > 32) {
    for (const [candidate, candidateUntil] of codexModelCapacityCooldowns) {
      if (candidateUntil <= Date.now()) codexModelCapacityCooldowns.delete(candidate);
    }
  }
  return cooldownMs;
}

function clearCodexModelCapacityCooldown({ root = '', model = '' } = {}) {
  codexModelCapacityCooldowns.delete(codexModelCapacityKey({ root, model }));
}

function waitForCodexModelCapacityCooldown({ root = '', model = '', signal = null } = {}) {
  const until = Number(codexModelCapacityCooldowns.get(codexModelCapacityKey({ root, model })) || 0);
  const delayMs = Math.max(0, until - Date.now());
  if (!delayMs) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer = null;
    const finish = (error = null) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new Error('Codex app-server turn was cancelled during model capacity cooldown.'));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(), delayMs);
  });
}

function codexTransientContinuationPrompt() {
  return [
    'The previous turn was interrupted by a transient model-service capacity or network error.',
    'Continue the original request from the existing thread state and preserve all completed reasoning, tool results, and stage outputs.',
    'Do not repeat commands, file changes, external actions, or other side effects that already completed.',
    'If completion of an earlier action is uncertain, verify the current state with a read-only check before deciding whether any remaining work is needed.',
    'Finish only the incomplete portion and then deliver the requested final result.',
  ].join(' ');
}

function addCodexTokenUsage(left = null, right = null) {
  const first = codexTokenUsage(left || {}) || {};
  const second = codexTokenUsage(right || {}) || {};
  const inputTokens = Math.max(0, Number(first.inputTokens) || 0) + Math.max(0, Number(second.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(first.outputTokens) || 0) + Math.max(0, Number(second.outputTokens) || 0);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: Math.max(0, Number(first.cachedInputTokens) || 0) + Math.max(0, Number(second.cachedInputTokens) || 0),
    cacheWriteInputTokens: Math.max(0, Number(first.cacheWriteInputTokens) || 0) + Math.max(0, Number(second.cacheWriteInputTokens) || 0),
    reasoningOutputTokens: Math.max(0, Number(first.reasoningOutputTokens) || 0) + Math.max(0, Number(second.reasoningOutputTokens) || 0),
    totalTokens: Math.max(0, Number(first.totalTokens) || 0) + Math.max(0, Number(second.totalTokens) || 0),
  };
}

function beginModelExecutionTrace({
  root, agentId = '', role = 'agent', model = '', reasoningEffort = '', permissionMode = '',
  sandbox = DEFAULT_CODEX_SANDBOX, readOnly = false, executionBackend = '', executionContext = null,
} = {}) {
  const store = executionContext?.store;
  if (!store?.beginModelExecution) return null;
  const config = codexConfigStatus(root);
  const id = executionContext.id || newId('model_exec');
  const permission = readOnly
    ? { ...codexPermissionProfile('request-approval'), sandbox: 'read-only' }
    : permissionMode ? codexPermissionProfile(permissionMode) : null;
  const runtimeMetadata = {
    permissionMode: permission?.mode || String(permissionMode || ''),
    sandbox: permission?.sandbox || sandbox || DEFAULT_CODEX_SANDBOX,
    approvalPolicy: permission?.approvalPolicy || '',
    approvalsReviewer: permission?.approvalsReviewer || '',
    executionBackend: executionBackend || codexExecutionBackend(permission, process.platform),
    platform: process.platform,
  };
  store.beginModelExecution({
    id,
    userId: executionContext.userId || '',
    projectId: executionContext.projectId || '',
    conversationId: executionContext.conversationId || '',
    requestMessageId: executionContext.requestMessageId || '',
    responseMessageId: executionContext.responseMessageId || '',
    taskRunId: executionContext.taskRunId || '',
    taskNodeId: executionContext.taskNodeId || '',
    departmentId: executionContext.departmentId || '',
    agentId: executionContext.agentId || agentId || '',
    agentInstanceId: executionContext.agentInstanceId || '',
    agentVersionId: executionContext.agentVersionId || '',
    personalSkillVersionId: executionContext.personalSkillVersionId || '',
    agentRole: executionContext.agentRole || 'agent',
    executionKind: executionContext.executionKind || role || 'agent',
    providerId: executionContext.providerId || config.providerName || '',
    requestedModel: model || '',
    effectiveModel: model || config.model || '',
    reasoningEffort: reasoningEffort || config.reasoningEffort || '',
    modelSource: executionContext.modelSource || (model ? 'request' : 'config_default'),
    codexThreadId: executionContext.codexThreadId || '',
    codexTurnId: executionContext.codexTurnId || '',
    skillHash: executionContext.skillHash || '',
    memoryHash: executionContext.memoryHash || '',
    memoryManifestHash: executionContext.memoryManifestHash || '',
    organizationVersion: executionContext.organizationVersion || '',
    metadata: {
      ...(executionContext.metadata || {}),
      codexRuntime: {
        ...(executionContext.metadata?.codexRuntime || {}),
        ...runtimeMetadata,
      },
    },
  });
  return { id, store };
}

function finishModelExecutionTrace(trace, { status = 'completed', error = null, threadId = '', turnId = '', usage = null } = {}) {
  if (!trace?.store?.completeModelExecution) return;
  const normalizedUsage = codexTokenUsage(usage || {});
  const existing = trace.store.getModelExecution?.(trace.id);
  const executionUsage = modelExecutionTokenUsage(normalizedUsage);
  trace.store.completeModelExecution(trace.id, {
    status,
    errorText: error ? clipText(error.message || String(error), 2000) : '',
    codexThreadId: threadId || '',
    codexTurnId: turnId || '',
    ...(executionUsage ? {
      metadata: {
        ...(existing?.metadata || {}),
        usage: executionUsage,
        ...(normalizedUsage?.last ? { threadTokenUsage: normalizedUsage } : {}),
      },
    } : {}),
  });
}

function modelExecutionTokenUsage(usage = null) {
  if (!usage) return null;
  const source = usage.last || usage;
  const normalized = { ...source };
  normalized.contextInputTokens = Number.isFinite(Number(usage.contextInputTokens))
    ? Math.max(0, Math.floor(Number(usage.contextInputTokens)))
    : Math.max(0, Math.floor(Number(source.inputTokens) || 0));
  normalized.contextMeasurementState = usage.contextMeasurementState === 'available' ? 'available' : 'unknown';
  if (usage.modelContextWindow) normalized.modelContextWindow = usage.modelContextWindow;
  return normalized;
}

export async function runCodexExec(args = {}) {
  const usageProviderState = modelUsageProviderState(args.root || '');
  if (args.executionContext?.store && args.executionContext?.userId) {
    assertManagedProviderQuotaAvailable(args.executionContext.store, args.executionContext.userId, {
      root: args.root || '', providerState: usageProviderState,
    });
  }
  const permission = args.permissionMode ? codexPermissionProfile(args.permissionMode) : null;
  const executionBackend = codexExecutionBackend(permission, process.platform);
  const trace = beginModelExecutionTrace({ ...args, executionBackend });
  try {
    const result = await runCodexExecUntracked(args);
    const normalizedResult = result && typeof result === 'object' ? result : { answer: result };
    settleCodexExecutionUsage(trace, args, {
      result: normalizedResult,
      providerState: usageProviderState,
      status: args.dryRun ? 'dry_run' : 'completed',
    });
    finishModelExecutionTrace(trace, {
      status: args.dryRun ? 'dry_run' : 'completed',
      threadId: normalizedResult.threadId || '', turnId: normalizedResult.turnId || '', usage: normalizedResult.usage || null,
    });
    return normalizedResult.answer;
  } catch (error) {
    const interrupted = error?.code === 'codex_turn_interrupted';
    settleCodexExecutionUsage(trace, args, {
      result: { usageEvents: error?.codexUsageEvents || [] },
      providerState: usageProviderState,
      status: interrupted ? 'cancelled' : 'failed',
    });
    finishModelExecutionTrace(trace, { status: interrupted ? 'cancelled' : 'failed', error,
      usage: error?.codexUsageEvents?.at?.(-1)?.usage || null });
    throw error;
  }
}

async function runCodexExecUntracked({
  prompt,
  agentId,
  root,
  cwd = root,
  role = 'agent',
  sandbox = DEFAULT_CODEX_SANDBOX,
  timeoutMs = 900_000,
  dryRun = false,
  signal = null,
  model = '',
  reasoningEffort = '',
  permissionMode = '',
  onApproval = null,
  onEvent = null,
  heartbeatMs = 0,
  onHeartbeat = null,
  executionContext = null,
  harnessMode = 'auto',
  dynamicTools = [],
  onDynamicToolCall = null,
  onTurnControlReady = null,
}) {
  const harnessPrompt = codexHarnessAssignment(prompt, { agentId, role, harnessMode });
  if (dryRun) return { answer: `[dry-run prompt]\n\n${harnessPrompt}`, usage: null, usageEvents: [] };
  const codexBin = await resolveCodexBinary();
  if (!codexBin) {
    throw new CodexUnavailable('Codex CLI was not found. Install Codex or set JANUS_CODEX_BIN to the executable path.');
  }
  const tmp = tmpDir(root);
  await ensureDir(tmp);
  const outputPath = path.join(tmp, `codex-last-message-${newId()}.txt`);
  const tempParent = path.join(tmp, 'codex');
  await ensureDir(tempParent);
  const tempHome = await fs.promises.mkdtemp(path.join(tempParent, `${role}-${agentId}-`));
  const permission = permissionMode ? codexPermissionProfile(permissionMode) : null;
  if (codexExecutionBackend(permission, process.platform) === 'app-server') {
    try {
      await prepareCodexHome(root, tempHome, {
        useMemories: false, generateMemories: false,
        attachedSkills: attachedSkillsForExecution(executionContext), targetAgentId: executionContext?.agentId || agentId,
        nativePluginUserId: executionContext?.userId || '',
      });
      const result = await runCodexAppServerTurn({
        codexBin,
        root,
        cwd,
        codexHome: tempHome,
        prompt: harnessPrompt,
        model,
        reasoningEffort,
        permission,
        ephemeral: true,
        timeoutMs,
        signal,
        onEvent,
        onApproval,
        onTurnControlReady,
        dynamicTools,
        onDynamicToolCall,
        memoryGenerateEnabled: false,
      });
      return result;
    } finally {
      await removeTemporaryCodexHome(tempHome);
    }
  }
  const effectiveSandbox = permission?.sandbox || sandbox;
  const cmd = codexExecCommand({
    codexBin,
    root,
    cwd,
    outputPath,
    sandbox: effectiveSandbox,
    model,
    reasoningEffort,
    json: Boolean(onEvent),
  });
  const parseStreamEvent = createCodexStreamEventParser();
  let tokenUsage = null;
  try {
    await prepareCodexHome(root, tempHome, {
      useMemories: false, generateMemories: false,
      attachedSkills: attachedSkillsForExecution(executionContext), targetAgentId: executionContext?.agentId || agentId,
      nativePluginUserId: executionContext?.userId || '',
    });
    const result = await runProcess(cmd[0], cmd.slice(1), {
      cwd,
      env: codexEnv(root, tempHome),
      input: harnessPrompt,
      timeoutMs,
      resetTimeoutOnOutput: true,
      signal,
      onStdoutLine: (line) => {
        const event = parseStreamEvent(line);
        if (!event) return;
        if (event.kind === 'usage') tokenUsage = event.usage || tokenUsage;
        if (onEvent) onEvent(event);
      },
      heartbeatMs,
      onHeartbeat,
    });
    const text = readText(outputPath, result.stdout).trim() || result.stdout.trim();
    if (result.code !== 0) {
      throw new CodexUnavailable(`Codex exec failed with code ${result.code}: ${result.stderr.trim() || text}`);
    }
    return { answer: text, usage: tokenUsage, usageEvents: tokenUsage ? [{ usage: tokenUsage, usageKind: 'turn', status: 'completed' }] : [] };
  } catch (error) {
    const failure = codexExecProcessFailure(error);
    if (tokenUsage) failure.codexUsageEvents = [{ usage: tokenUsage, usageKind: 'turn', status: 'failed' }];
    throw failure;
  } finally {
    await removeTemporaryCodexHome(tempHome);
  }
}

export async function compactCodexThread({
  root,
  cwd = root,
  sessionId = '',
  threadId = '',
  model = '',
  memoryUseEnabled = true,
  memoryGenerateEnabled = false,
  isolatedPrivateSession = false,
  timeoutMs = 120_000,
  signal = null,
  nativePluginUserId = '',
} = {}) {
  const cleanSessionId = String(sessionId || '').trim();
  const cleanThreadId = String(threadId || '').trim();
  if (!cleanSessionId || !cleanThreadId) {
    const error = new Error('Codex native compaction requires an existing session thread.');
    error.code = 'codex_thread_unavailable';
    throw error;
  }
  const codexBin = await resolveCodexBinary();
  if (!codexBin) {
    throw new CodexUnavailable('Codex CLI was not found. Install Codex or set JANUS_CODEX_BIN to the executable path.');
  }
  const codexHome = codexHomeForSession(root, cleanSessionId);
  await prepareCodexHome(root, codexHome, {
    useMemories: memoryUseEnabled,
    generateMemories: memoryGenerateEnabled,
    isolatedPrivateSession,
    nativePluginUserId,
  });
  const permission = codexPermissionProfile('draft-stream');
  const appServerArgs = [...codexProviderRelayArgs(root), ...await compatibleAppServerArgs(codexBin)];
  return new Promise((resolve, reject) => {
    const child = trackCodexChild(spawn(codexBin, appServerArgs, {
      cwd,
      env: codexEnv(root, codexHome),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(codexBin),
    }), { kind: 'native-compaction', runId: cleanSessionId });
    const pending = new Map();
    let requestId = 0;
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    let usage = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abortHandler);
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      for (const waiter of pending.values()) waiter.reject(error || new Error('Codex app-server closed.'));
      pending.clear();
      void closeCodexChild(child).then((closed) => {
        if (!closed) codexLogger.warn('native-compaction-forced-exit-unconfirmed', { data: { pid: child.pid } });
        if (!error) {
          resolve({ threadId: cleanThreadId, usage, source: 'codex_native' });
          return;
        }
        const unavailable = error instanceof CodexUnavailable ? error : new CodexUnavailable(error.message || String(error));
        if (error.code) unavailable.code = error.code;
        reject(unavailable);
      });
    };
    const send = (message) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
    };
    const request = (method, params = {}) => new Promise((requestResolve, requestReject) => {
      const id = ++requestId;
      pending.set(String(id), { resolve: requestResolve, reject: requestReject, method });
      send({ id, method, params });
    });
    const abortHandler = () => {
      const error = new Error('Codex native compaction was cancelled.');
      error.code = 'codex_native_compaction_cancelled';
      finish(error);
    };
    const handleLine = (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const key = message.id == null ? '' : String(message.id);
      if (key && pending.has(key) && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
        const waiter = pending.get(key);
        pending.delete(key);
        if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else waiter.resolve(message.result);
        return;
      }
      if (key && message.method) {
        send({ id: message.id, error: { code: -32000, message: `Unsupported app-server request during compaction: ${message.method}` } });
        return;
      }
      const params = message.params || {};
      if (/token.?usage/i.test(String(message.method || ''))) {
        usage = codexTokenUsage(params) || usage;
        return;
      }
      if (message.method === 'item/completed' && codexItemType(params.item) === 'contextcompaction') {
        finish();
        return;
      }
      if (message.method === 'thread/compacted') {
        finish();
        return;
      }
      if (message.method === 'turn/completed' && params.turn?.status === 'failed') {
        finish(new Error(params.turn?.error?.message || 'Codex native compaction failed.'));
        return;
      }
      if (message.method === 'error' && !params.willRetry) {
        finish(new Error(params.error?.message || params.error || 'Codex native compaction failed.'));
      }
    };

    child.on('error', (error) => finish(error));
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) if (line.trim()) handleLine(line.trim());
    });
    child.on('close', (code) => {
      if (!settled) finish(new Error(`Codex app-server exited with code ${code ?? 0}: ${stderr.trim()}`));
    });
    if (signal) {
      if (signal.aborted) return abortHandler();
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const error = new Error(`Codex native compaction timed out after ${timeoutMs}ms.`);
        error.code = 'codex_native_compaction_timeout';
        finish(error);
      }, timeoutMs);
    }

    void (async () => {
      try {
        await request('initialize', {
          clientInfo: { name: 'janus', title: 'Janus Desktop', version: JANUS_CLIENT_VERSION },
          capabilities: { experimentalApi: true, requestAttestation: false },
        });
        send({ method: 'initialized' });
        try {
          await request('thread/resume', {
            threadId: cleanThreadId,
            model: model || null,
            cwd,
            approvalPolicy: permission.approvalPolicy,
            approvalsReviewer: permission.approvalsReviewer,
            sandbox: permission.sandbox,
          });
        } catch (resumeError) {
          const error = new Error(`Codex thread could not be resumed for native compaction: ${resumeError.message || resumeError}`);
          error.code = 'codex_thread_unavailable';
          throw error;
        }
        await setCodexThreadMemoryMode(request, cleanThreadId, memoryGenerateEnabled);
        try {
          await request('thread/compact/start', { threadId: cleanThreadId });
        } catch (compactError) {
          if (isUnsupportedAppServerMethod(compactError, 'thread/compact/start')
            || /(unknown variant|unknown method|method not found|unsupported method)/i.test(String(compactError?.message || compactError))) {
            compactError.code = 'codex_native_compaction_unsupported';
          }
          throw compactError;
        }
      } catch (error) {
        finish(error);
      }
    })();
  });
}

export async function updateCodexGoal({
  root,
  cwd = root,
  sessionId = '',
  threadId = '',
  action = '',
  objective = '',
  memoryUseEnabled = true,
  memoryGenerateEnabled = false,
  timeoutMs = 30_000,
  signal = null,
  nativePluginUserId = '',
} = {}) {
  const cleanSessionId = String(sessionId || '').trim();
  const cleanThreadId = String(threadId || '').trim();
  const cleanAction = String(action || '').trim();
  if (!cleanSessionId || !cleanThreadId) {
    const error = new Error('Codex Goal update requires an existing session thread.');
    error.code = 'codex_thread_unavailable';
    throw error;
  }
  if (!['edit', 'pause', 'resume', 'delete'].includes(cleanAction)) {
    throw new Error('Unsupported Codex Goal action.');
  }
  const codexBin = await resolveCodexBinary();
  if (!codexBin) {
    throw new CodexUnavailable('Codex CLI was not found. Install Codex or set JANUS_CODEX_BIN to the executable path.');
  }
  const codexHome = codexHomeForSession(root, cleanSessionId);
  await prepareCodexHome(root, codexHome, {
    useMemories: memoryUseEnabled,
    generateMemories: memoryGenerateEnabled,
    nativePluginUserId,
  });
  const permission = codexPermissionProfile('draft-stream');
  const appServerArgs = [...codexProviderRelayArgs(root), ...await compatibleAppServerArgs(codexBin)];
  return new Promise((resolve, reject) => {
    const child = trackCodexChild(spawn(codexBin, appServerArgs, {
      cwd,
      env: codexEnv(root, codexHome),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(codexBin),
    }), { kind: 'goal-update', runId: cleanSessionId });
    const pending = new Map();
    let requestId = 0;
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abortHandler);
    };
    const finish = (error = null, goal = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      for (const waiter of pending.values()) waiter.reject(error || new Error('Codex app-server closed.'));
      pending.clear();
      void closeCodexChild(child).then(() => {
        if (!error) return resolve({ threadId: cleanThreadId, goal });
        const unavailable = error instanceof CodexUnavailable ? error : new CodexUnavailable(error.message || String(error));
        if (error.code) unavailable.code = error.code;
        reject(unavailable);
      });
    };
    const send = (message) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
    };
    const request = (method, params = {}) => new Promise((requestResolve, requestReject) => {
      const id = ++requestId;
      pending.set(String(id), { resolve: requestResolve, reject: requestReject });
      send({ id, method, params });
    });
    const abortHandler = () => {
      const error = new Error('Codex Goal update was cancelled.');
      error.code = 'codex_goal_update_cancelled';
      finish(error);
    };
    const handleLine = (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const key = message.id == null ? '' : String(message.id);
      if (key && pending.has(key) && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
        const waiter = pending.get(key);
        pending.delete(key);
        if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else waiter.resolve(message.result);
        return;
      }
      if (key && message.method) {
        send({ id: message.id, error: { code: -32000, message: `Unsupported app-server request during Goal update: ${message.method}` } });
      }
    };

    child.on('error', (error) => finish(error));
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) if (line.trim()) handleLine(line.trim());
    });
    child.on('close', (code) => {
      if (!settled) finish(new Error(`Codex app-server exited with code ${code ?? 0}: ${stderr.trim()}`));
    });
    if (signal) {
      if (signal.aborted) return abortHandler();
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const error = new Error(`Codex Goal update timed out after ${timeoutMs}ms.`);
        error.code = 'codex_goal_update_timeout';
        finish(error);
      }, timeoutMs);
    }

    void (async () => {
      try {
        await request('initialize', {
          clientInfo: { name: 'janus', title: 'Janus Desktop', version: JANUS_CLIENT_VERSION },
          capabilities: { experimentalApi: true, requestAttestation: false },
        });
        send({ method: 'initialized' });
        await request('thread/resume', {
          threadId: cleanThreadId,
          model: null,
          cwd,
          approvalPolicy: permission.approvalPolicy,
          approvalsReviewer: permission.approvalsReviewer,
          sandbox: permission.sandbox,
        });
        const current = await request('thread/goal/get', { threadId: cleanThreadId });
        if (cleanAction === 'delete') {
          if (current?.goal) await request('thread/goal/clear', { threadId: cleanThreadId });
          finish(null, null);
          return;
        }
        const nextObjective = String(cleanAction === 'edit' ? objective : current?.goal?.objective || objective).trim().slice(0, 4000);
        if (!nextObjective) throw new Error('Goal objective cannot be empty.');
        const updated = await request('thread/goal/set', {
          threadId: cleanThreadId,
          objective: nextObjective,
          status: cleanAction === 'pause' ? 'paused' : cleanAction === 'resume' ? 'active' : current?.goal?.status || 'active',
          tokenBudget: null,
        });
        finish(null, updated?.goal || null);
      } catch (error) {
        if (isUnsupportedAppServerMethod(error, 'thread/goal')) error.code = 'codex_goal_update_unsupported';
        finish(error);
      }
    })();
  });
}

export async function runCodexSession(args = {}) {
  const usageProviderState = modelUsageProviderState(args.root || '');
  if (args.executionContext?.store && args.executionContext?.userId) {
    assertManagedProviderQuotaAvailable(args.executionContext.store, args.executionContext.userId, {
      root: args.root || '', providerState: usageProviderState,
    });
  }
  const executionBackend = args.readOnly || args.permissionMode ? 'app-server' : 'exec';
  const trace = beginModelExecutionTrace({
    ...args,
    executionBackend,
    agentId: args.executionContext?.agentId || '',
    role: args.executionContext?.executionKind || 'chat',
  });
  const contextMetadata = args.executionContext?.metadata || {};
  const trackedArgs = {
    ...args,
    onEvent: (event) => {
      if (event?.providerCompactionDetected && trace?.store?.markChatContextProviderCompaction
        && args.executionContext?.userId && (args.executionContext?.conversationId || args.sessionId)) {
        trace.store.markChatContextProviderCompaction({
          ownerUserId: args.executionContext?.userId || '',
          sessionId: args.executionContext?.conversationId || args.sessionId || '',
          contextSpaceId: contextMetadata.contextSpaceId || '',
          sourceDeviceId: contextMetadata.sourceDeviceId || '',
        });
      }
      args.onEvent?.(event);
    },
  };
  try {
    const result = await runCodexSessionUntracked(trackedArgs);
    const usage = codexTokenUsage(result?.usage || result || {});
    const usageSettlement = settleCodexExecutionUsage(trace, args, {
      result,
      providerState: usageProviderState,
      status: 'completed',
    });
    finishModelExecutionTrace(trace, {
      status: 'completed', threadId: result.threadId || '', turnId: result.turnId || '', usage,
    });
    if (usage && trace?.store?.recordChatContextUsage && args.executionContext?.userId && (args.executionContext?.conversationId || args.sessionId)) {
      trace.store.recordChatContextUsage({
        ownerUserId: args.executionContext.userId,
        sessionId: args.executionContext.conversationId || args.sessionId,
        contextSpaceId: contextMetadata.contextSpaceId || '',
        executionId: trace.id,
        inputTokens: usage.contextInputTokens || 0,
        contextWindowTokens: usage.modelContextWindow || contextMetadata.contextWindowTokens || 0,
        sourceDeviceId: contextMetadata.sourceDeviceId || '',
      });
    }
    if (usageSettlement.status) args.onEvent?.({ kind: 'managed-provider-usage', usage: usageSettlement.status });
    return { ...result, executionId: trace?.id || '', managedProviderUsage: usageSettlement.status || null };
  } catch (error) {
    const usageSettlement = settleCodexExecutionUsage(trace, args, {
      result: { usageEvents: error?.codexUsageEvents || [] },
      providerState: usageProviderState,
      status: 'failed',
    });
    finishModelExecutionTrace(trace, {
      status: 'failed', error, threadId: args.threadId || '',
      usage: error?.codexUsageEvents?.at?.(-1)?.usage || null,
    });
    if (usageSettlement.status) args.onEvent?.({ kind: 'managed-provider-usage', usage: usageSettlement.status });
    throw error;
  }
}

function settleCodexExecutionUsage(trace, args = {}, {
  result = {},
  providerState = null,
  status = 'completed',
} = {}) {
  const store = trace?.store || args.executionContext?.store;
  const userId = String(args.executionContext?.userId || '').trim();
  if (!store || !userId) return { status: null, inserted: 0 };
  const execution = trace?.id ? store.getModelExecution?.(trace.id) : null;
  const events = Array.isArray(result?.usageEvents) && result.usageEvents.length
    ? result.usageEvents
    : result?.usage ? [{
        threadId: result.threadId || args.threadId || '',
        turnId: result.turnId || '',
        usage: result.usage,
        usageKind: result.usage?.last ? 'thread_cumulative' : 'turn',
        status,
        resumedExistingThread: Boolean(args.threadId),
      }]
      : [];
  let latestStatus = null;
  let inserted = 0;
  events.forEach((event, eventIndex) => {
    const recorded = recordModelTokenUsage(store, {
      root: args.root || '',
      userId,
      accountWorkspaceId: execution?.accountWorkspaceId || args.executionContext?.accountWorkspaceId || '',
      executionId: trace?.id || args.executionContext?.id || '',
      sessionId: args.executionContext?.conversationId || args.sessionId || '',
      threadId: event.threadId || result.threadId || args.threadId || '',
      turnId: event.turnId || '',
      eventIndex,
      agentId: args.executionContext?.agentId || '',
      agentInstanceId: args.executionContext?.agentInstanceId || '',
      model: event.model || result.effectiveModel || args.model || execution?.effectiveModel || '',
      reasoningEffort: args.reasoningEffort || execution?.reasoningEffort || '',
      usage: event.usage,
      usageKind: event.usageKind || 'auto',
      cursorUsage: event.cursorUsage || null,
      status: event.status || status,
      privateAssistant: args.executionContext?.executionKind === 'private_assistant_chat',
      resumedExistingThread: Boolean(event.resumedExistingThread),
      providerState,
      usageSource: event.usageSource || '',
    });
    if (recorded.inserted) inserted += 1;
    latestStatus = recorded.status || latestStatus;
  });
  return { status: latestStatus, inserted };
}

async function runCodexSessionUntracked({
  prompt,
  freshPrompt = '',
  root,
  cwd = root,
  sessionId,
  threadId = '',
  sandbox = DEFAULT_CODEX_SANDBOX,
  model = '',
  reasoningEffort = '',
  onEvent = null,
  signal = null,
  permissionMode = '',
  readOnly = false,
  onApproval = null,
  onUserInput = null,
  dynamicTools = [],
  onDynamicToolCall = null,
  executionContext = null,
  interactionMode = '',
  goalObjective = '',
  replaceGoal = false,
  memoryUseEnabled = true,
  memoryGenerateEnabled = false,
  isolatedPrivateSession = false,
  nativeMultiAgentEnabled = true,
  timeoutMs = 0,
}) {
  const selectedAgentId = String(executionContext?.agentId || '').trim();
  const harnessPrompt = codexHarnessAssignment(prompt, {
    agentId: selectedAgentId,
    role: executionContext?.executionKind || 'agent_chat',
  });
  const freshHarnessPrompt = freshPrompt
    ? codexHarnessAssignment(freshPrompt, {
        agentId: selectedAgentId,
        role: executionContext?.executionKind || 'agent_chat',
      })
    : harnessPrompt;
  const codexBin = await resolveCodexBinary();
  if (!codexBin) {
    throw new CodexUnavailable('Codex CLI was not found. Install Codex or set JANUS_CODEX_BIN to the executable path.');
  }
  const tmp = tmpDir(root);
  await ensureDir(tmp);
  const outputPath = path.join(tmp, `codex-last-message-${newId()}.txt`);
  const codexHome = codexHomeForSession(root, sessionId);
  await prepareCodexHome(root, codexHome, {
    useMemories: memoryUseEnabled,
    generateMemories: memoryGenerateEnabled,
    isolatedPrivateSession,
    nativeMultiAgentEnabled,
    attachedSkills: attachedSkillsForExecution(executionContext),
    targetAgentId: selectedAgentId,
    nativePluginUserId: executionContext?.userId || '',
  });
  let permission = readOnly
    ? { ...codexPermissionProfile('request-approval'), sandbox: 'read-only' }
    : permissionMode ? codexPermissionProfile(permissionMode) : null;
  if (interactionMode && permission && !permission.appServer) {
    permission = { ...permission, appServer: true };
  }
  if (permission) {
    return runCodexAppServerTurn({
      codexBin,
      root,
      cwd,
      codexHome,
      prompt: harnessPrompt,
      freshPrompt: freshHarnessPrompt,
      threadId,
      model,
      reasoningEffort,
      permission,
      ephemeral: false,
      signal,
      onEvent,
      onApproval,
      onUserInput,
      dynamicTools,
      onDynamicToolCall,
      interactionMode,
      goalObjective,
      replaceGoal,
      memoryGenerateEnabled,
      timeoutMs,
    });
  }
  const cmd = codexSessionCommand({
    codexBin,
    root,
    cwd,
    outputPath,
    threadId,
    sandbox: permission?.sandbox || sandbox,
    model,
    reasoningEffort,
  });
  let emittedAnswer = '';
  let lastAnswer = '';
  let tokenUsage = null;
  const generatedImagePaths = [];
  const parseStreamEvent = createCodexStreamEventParser();
  const emitAnswerChunks = (text) => {
    const value = String(text || '');
    if (!value || !onEvent) return;
    const chunkSize = 80;
    for (let index = 0; index < value.length; index += chunkSize) {
      const content = value.slice(index, index + chunkSize);
      emittedAnswer += content;
      onEvent({ kind: 'token', content });
    }
  };
  const emitAnswerCorrection = (text) => {
    const value = stripProcessSummary(text || '');
    if (!value || !onEvent || value === emittedAnswer) return;
    if (!emittedAnswer) {
      emitAnswerChunks(value);
    } else if (value.startsWith(emittedAnswer)) {
      emitAnswerChunks(value.slice(emittedAnswer.length));
    } else {
      emittedAnswer = value;
      onEvent({ kind: 'answer', content: value });
    }
  };
  const result = await runProcess(cmd[0], cmd.slice(1), {
    cwd,
    env: codexEnv(root, codexHome),
    input: harnessPrompt,
    timeoutMs,
    resetTimeoutOnOutput: true,
    signal,
    heartbeatMs: heartbeatIntervalMs(),
    onHeartbeat: (elapsed) => {
      if (onEvent) onEvent({ kind: 'heartbeat', elapsed });
    },
    onStdoutLine: (line) => {
      try {
        const rawEvent = JSON.parse(line);
        if (rawEvent?.type === 'item.completed') {
          collectCodexGeneratedImagePath(generatedImagePaths, rawEvent.item || {}, cwd, path.join(tmpDir(root), 'codex-generated-images'));
        }
      } catch {
        // Non-JSON output is handled by the normal Codex stream parser below.
      }
      const parsed = parseStreamEvent(line);
      if (!parsed) return;
      if (parsed.kind === 'token') {
        emittedAnswer += parsed.content || '';
        if (onEvent) onEvent(parsed);
      } else if (parsed.kind === 'answer') {
        lastAnswer = parsed.content || lastAnswer;
        emitAnswerCorrection(parsed.content);
      } else if (parsed.kind === 'complete') {
        lastAnswer = parsed.answer || lastAnswer;
      } else if (parsed.kind === 'usage') {
        tokenUsage = parsed.usage || tokenUsage;
      } else if (onEvent) {
        onEvent(parsed);
      }
    },
  });
  const newThreadId = extractCodexThreadId(result.stdout) || threadId || '';
  const outputText = readText(outputPath, '').trim();
  const answer = stripProcessSummary(outputText || lastAnswer || result.stdout.trim());
  if (result.code !== 0 && !isNonFatalCodexMemoryNoChanges({
    code: result.code,
    stderr: result.stderr,
    answer,
  })) {
    const failure = new CodexUnavailable(`Codex session failed with code ${result.code}: ${result.stderr.trim() || answer}`);
    if (tokenUsage) failure.codexUsageEvents = [{
      threadId: newThreadId,
      usage: tokenUsage,
      usageKind: 'turn',
      status: 'failed',
      resumedExistingThread: Boolean(threadId),
    }];
    throw failure;
  }
  emitAnswerCorrection(answer);
  return {
    answer,
    threadId: newThreadId,
    usage: tokenUsage,
    usageEvents: tokenUsage ? [{
      threadId: newThreadId,
      usage: tokenUsage,
      usageKind: 'turn',
      status: 'completed',
      resumedExistingThread: Boolean(threadId),
    }] : [],
    generatedImagePaths,
  };
}

function dynamicToolFailure(message = '') {
  return {
    success: false,
    contentItems: [{ type: 'inputText', text: JSON.stringify({ ok: false, error: String(message || 'Dynamic tool failed.') }) }],
  };
}

function normalizeDynamicToolResult(value = null) {
  if (value && typeof value === 'object' && Array.isArray(value.contentItems)) {
    return {
      success: value.success !== false,
      contentItems: value.contentItems.map((item) => {
        if (item?.type === 'inputImage' && item.imageUrl) return { type: 'inputImage', imageUrl: String(item.imageUrl) };
        return { type: 'inputText', text: String(item?.text || '') };
      }),
    };
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? { ok: true });
  return { success: true, contentItems: [{ type: 'inputText', text }] };
}

function collectCodexGeneratedImagePath(paths, item, cwd, fallbackDir = '') {
  const savedPath = codexGeneratedImagePath(item);
  const materializedPath = savedPath || materializeCodexGeneratedImageResult(item, fallbackDir);
  if (!materializedPath) return;
  const resolved = path.isAbsolute(materializedPath) ? path.normalize(materializedPath) : path.resolve(cwd, materializedPath);
  if (!paths.includes(resolved)) paths.push(resolved);
}

export function materializeCodexGeneratedImageResult(item = {}, outputDir = '') {
  if (codexItemType(item) !== 'imagegeneration') return '';
  const directory = String(outputDir || '').trim();
  if (!directory) return '';
  const encoded = String(item.result || '').trim();
  if (!encoded) return '';
  const dataUrl = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(encoded);
  const base64 = (dataUrl?.[2] || encoded).replace(/\s+/g, '');
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return '';
  let bytes;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return '';
  }
  const extension = generatedImageExtension(bytes, dataUrl?.[1] || '');
  if (!extension) return '';
  fs.mkdirSync(directory, { recursive: true });
  const itemId = String(item.id || newId('image_generation'))
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || newId('image_generation');
  const target = path.join(directory, `${itemId}.${extension}`);
  if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { flag: 'wx' });
  return target;
}

function generatedImageExtension(bytes, hintedType = '') {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return '';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  return ['png', 'jpeg', 'jpg', 'webp', 'gif'].includes(String(hintedType || '').toLowerCase())
    ? String(hintedType).toLowerCase().replace('jpeg', 'jpg')
    : '';
}

function codexItemType(item = {}) {
  return String(item?.type || '').replaceAll('_', '').toLowerCase();
}

function codexImageToolTimeoutMs() {
  const configured = Number(process.env.JANUS_CODEX_IMAGE_TOOL_TIMEOUT_MS || 300_000);
  return Number.isFinite(configured) && configured > 0 ? Math.max(100, configured) : 300_000;
}

function clearCodexImageToolTimer(timers, itemId = '') {
  if (!itemId || !timers.has(itemId)) return;
  clearTimeout(timers.get(itemId));
  timers.delete(itemId);
}

export function isNonFatalCodexMemoryNoChanges({ code = 0, stderr = '', answer = '' } = {}) {
  if (!code || !String(answer || '').trim()) return false;
  const normalized = String(stderr || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim();
  return /^(?:\d{4}-\d{2}-\d{2}T\S+\s+)?ERROR\s+codex_memories_write::phase2:\s*Phase 2\s+no changes\s*$/i.test(normalized);
}

export async function runCodexDoctor(root) {
  const codexBin = await resolveCodexBinary();
  if (!codexBin) {
    return { available: false, overallStatus: 'fail', error: 'Codex CLI was not found.' };
  }
  const config = codexConfigStatus(root);
  const auth = loadAuthEnv(root);
  const apiKey = String(auth[config.authEnvKey || 'OPENAI_API_KEY'] || '').trim();
  const checks = {};
  let codexVersion = '';
  try {
    const version = await runProcess(codexBin, ['--version'], {
      cwd: root,
      env: codexEnv(root),
      timeoutMs: 10_000,
    });
    codexVersion = String(version.stdout || version.stderr || '').trim();
    checks.installation = version.code === 0
      ? { status: 'pass', summary: codexVersion || 'Codex CLI 可执行。' }
      : { status: 'fail', summary: `Codex CLI --version 退出码 ${version.code}。` };
  } catch (error) {
    checks.installation = { status: 'fail', summary: `Codex CLI 无法启动：${error.message || error}` };
  }

  checks['auth.credentials'] = apiKey
    ? { status: 'pass', summary: `${config.authEnvKey || 'OPENAI_API_KEY'} 已配置。` }
    : { status: 'fail', summary: `${config.authEnvKey || 'OPENAI_API_KEY'} 未配置。` };
  checks['config.load'] = validProviderBaseUrl(config.baseUrl)
    ? { status: 'pass', summary: `已加载 Provider ${config.providerName || 'custom'} 配置。` }
    : { status: 'fail', summary: 'Provider Base URL 缺失或不是有效的 HTTP(S) 地址。' };
  if (process.platform === 'win32') {
    const relay = codexProviderRelayStatus();
    checks['network.provider_relay'] = relay.enabled
      ? { status: 'pass', summary: 'Janus 本机 Provider relay 已启用。' }
      : { status: 'fail', summary: `Janus 本机 Provider relay 未启动：${relay.error || '未知错误'}` };
  }

  try {
    const help = await runProcess(codexBin, ['app-server', '--help'], {
      cwd: root,
      env: codexEnv(root),
      timeoutMs: 10_000,
    });
    const helpText = `${help.stdout}\n${help.stderr}`;
    const args = codexAppServerArgs(helpText);
    const transport = args.includes('--listen') ? '--listen stdio://' : args.includes('--stdio') ? '--stdio' : '默认 stdio';
    checks['runtime.app_server'] = help.code === 0
      ? { status: 'pass', summary: `App Server 将使用 ${transport}。` }
      : { status: 'warn', summary: `无法读取 app-server 帮助，将使用${transport}。` };
  } catch (error) {
    checks['runtime.app_server'] = { status: 'warn', summary: `无法探测 app-server 参数，将使用默认 stdio：${error.message || error}` };
  }

  checks['network.provider_reachability'] = await probeCodexProvider({
    baseUrl: config.baseUrl,
    apiKey,
    model: config.model,
  });
  try {
    const providerModelIds = await fetchProviderModelIds(root);
    if (providerModelIds.length && config.model) {
      checks['config.model_route'] = providerModelIds.includes(config.model)
        ? { status: 'pass', summary: `当前 Provider 可路由模型 ${config.model}。` }
        : { status: 'fail', summary: `当前 Provider 不提供模型 ${config.model}，请选择模型目录中的其他模型。` };
    }
  } catch (error) {
    checks['config.model_route'] = { status: 'warn', summary: `无法核对 Provider 模型路由：${clipText(error?.message || String(error), 300)}` };
  }
  checks['state.paths'] = fs.existsSync(sharedConfigPath(root)) && fs.existsSync(sharedAuthPath(root))
    ? { status: 'pass', summary: 'Janus Codex 配置文件可读。' }
    : { status: 'fail', summary: 'Janus Codex 配置文件缺失。' };

  const statuses = Object.values(checks).map((item) => item.status);
  const overallStatus = statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'pass';
  return {
    available: checks.installation.status === 'pass',
    overallStatus,
    codexVersion,
    codexSource: bundledCodexCandidates().includes(codexBin) ? 'bundled' : process.env.JANUS_CODEX_BIN ? 'configured' : 'system',
    exitCode: overallStatus === 'fail' ? 1 : 0,
    checks,
  };
}

export async function probeCodexProvider({
  baseUrl = '',
  apiKey = '',
  model = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  if (!validProviderBaseUrl(baseUrl)) {
    return { status: 'fail', summary: 'Provider Base URL 缺失或无效。' };
  }
  if (!String(apiKey || '').trim()) {
    return { status: 'fail', summary: 'API Key 未配置，未执行 Provider 鉴权请求。' };
  }
  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, '');
  const endpoint = `${normalizedBaseUrl}/models`;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${String(apiKey).trim()}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    let modelIds = [];
    if (response.ok) {
      if (typeof response.json === 'function') {
        try {
          const body = await response.json();
          modelIds = [...new Set((Array.isArray(body?.data) ? body.data : [])
            .map((item) => String(item?.id || '').trim()).filter(Boolean))];
        } catch {
          // A successful endpoint without a readable catalog still proves network and authentication.
        }
      }
    } else if (response.status === 401 || response.status === 403) {
      return { status: 'fail', summary: `Provider 拒绝 API Key（HTTP ${response.status}）。` };
    }
    const probeModel = String(model || modelIds[0] || '').trim();
    if (!probeModel) {
      return {
        status: 'warn',
        summary: response.ok
          ? 'Provider /models 可用，但没有可用于验证 Responses API 的模型。'
          : `Provider 可连接，但 /models 返回 HTTP ${response.status}，且未配置用于验证的模型。`,
        modelIds,
      };
    }
    const responses = await fetchImpl(`${normalizedBaseUrl}/responses`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${String(apiKey).trim()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: probeModel, input: 'Reply with OK.', max_output_tokens: 16, store: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await responses.arrayBuffer().catch(() => {});
    if (responses.ok) {
      return {
        status: 'pass',
        summary: `Provider 网络、鉴权和 Responses API 可用（HTTP ${responses.status}）。`,
        modelIds,
        modelVerified: true,
      };
    }
    if (responses.status === 401 || responses.status === 403) {
      return { status: 'fail', summary: `Provider Responses API 拒绝 API Key（HTTP ${responses.status}）。`, modelIds };
    }
    return {
      status: 'fail',
      summary: `Provider Responses API 返回 HTTP ${responses.status}。`,
      modelIds,
    };
  } catch (error) {
    const cause = error?.cause || {};
    const detail = [cause.code, cause.message || error.message || String(error)].filter(Boolean).join(': ');
    return { status: 'fail', summary: `Provider TLS/网络连接失败：${clipText(detail, 500)}` };
  }
}

function validProviderBaseUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export async function fetchCodexModelCatalog(root) {
  const codexBin = await resolveCodexBinary();
  if (!codexBin) {
    throw new CodexUnavailable('Codex CLI was not found. Model discovery is unavailable.');
  }
  const tmp = tmpDir(root);
  await ensureDir(tmp);
  const catalogHome = path.join(tmp, 'codex-model-catalog-home');
  await prepareCodexHome(root, catalogHome, { useMemories: false, generateMemories: false });
  const result = await runProcess(codexBin, [...codexProviderRelayArgs(root), 'debug', 'models'], {
    cwd: root,
    env: codexEnv(root, catalogHome),
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    throw new CodexUnavailable(`Codex model discovery failed with code ${result.code}: ${result.stderr.trim()}`);
  }
  try {
    const payload = JSON.parse(result.stdout || '{}');
    const providerModelIds = await fetchProviderModelIds(root).catch(() => []);
    return filterCodexModelCatalogForProvider(payload, providerModelIds);
  } catch (error) {
    throw new CodexUnavailable(`Codex model discovery returned invalid JSON: ${error.message}`);
  }
}

export async function fetchProviderModelIds(root, { fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const config = codexConfigStatus(root);
  const auth = loadAuthEnv(root);
  const apiKey = String(auth[config.authEnvKey || 'OPENAI_API_KEY'] || '').trim();
  const baseUrl = String(codexProviderRelayUrl || config.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl || !apiKey || typeof fetchImpl !== 'function') return [];
  const response = await fetchImpl(`${baseUrl}/models`, {
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Provider model discovery returned HTTP ${response.status}.`);
  const body = await response.json();
  return [...new Set((Array.isArray(body?.data) ? body.data : [])
    .map((item) => String(item?.id || '').trim())
    .filter(Boolean))];
}

export function filterCodexModelCatalogForProvider(payload = {}, providerModelIds = []) {
  const allowed = new Set((Array.isArray(providerModelIds) ? providerModelIds : []).map((item) => String(item || '').trim()).filter(Boolean));
  if (!allowed.size) return payload;
  const filter = (models) => (Array.isArray(models) ? models : []).filter((item) => allowed.has(String(item?.slug || item?.id || '').trim()));
  if (Array.isArray(payload)) return filter(payload);
  return { ...payload, models: filter(payload?.models) };
}

function heartbeatIntervalMs() {
  const value = Number(process.env.JANUS_CODEX_HEARTBEAT_MS || 10_000);
  return Number.isFinite(value) && value > 0 ? value : 10_000;
}

function codexAppServerFirstResponseTimeoutMs() {
  const value = Number(process.env.JANUS_CODEX_FIRST_RESPONSE_TIMEOUT_MS || 60_000);
  return Number.isFinite(value) && value >= 100 ? Math.min(value, 300_000) : 60_000;
}

function runProcess(command, args, {
  cwd,
  env,
  input = '',
  timeoutMs = 0,
  resetTimeoutOnOutput = false,
  signal = null,
  onStdoutLine = null,
  heartbeatMs = 0,
  onHeartbeat = null,
}) {
  return new Promise((resolve, reject) => {
    const processMode = ['exec', 'doctor', 'debug'].find((item) => args.includes(item)) || 'codex-cli';
    const child = trackCodexChild(spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    }), { kind: processMode });
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let settled = false;
    let timer = null;
    let heartbeatTimer = null;
    let terminationError = null;
    let terminationPromise = null;
    const startedAt = Date.now();
    let lastStdoutAt = startedAt;
    recordCodexDiagnostic('process-start', { pid: child.pid, mode: processMode, argumentCount: args.length, timeoutMs });

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (signal) signal.removeEventListener('abort', abortHandler);
      recordCodexDiagnostic(error ? 'process-failed' : 'process-complete', {
        pid: child.pid, mode: processMode, exitCode: result?.code ?? null,
        stdoutBytes: Buffer.byteLength(result?.stdout || ''), stderrBytes: Buffer.byteLength(result?.stderr || ''),
      }, error ? 'error' : 'info', error, Date.now() - startedAt);
      if (error) reject(error);
      else resolve(result);
    };

    const terminate = (error) => {
      if (terminationPromise) return terminationPromise;
      terminationError = error;
      terminationPromise = closeCodexChild(child).then(() => {
        finish(terminationError);
      });
      return terminationPromise;
    };
    const abortHandler = () => {
      void terminate(codexAbortError());
    };
    if (signal) {
      if (signal.aborted) abortHandler();
      else signal.addEventListener('abort', abortHandler, { once: true });
    }
    const armTimeout = () => {
      if (timer) clearTimeout(timer);
      if (timeoutMs <= 0) return;
      timer = setTimeout(() => {
        void terminate(new Error(`Process timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);
    };
    armTimeout();
    if (onHeartbeat && heartbeatMs > 0) {
      heartbeatTimer = setInterval(() => {
        const now = Date.now();
        if (now - lastStdoutAt >= Math.max(1, heartbeatMs - 500)) {
          onHeartbeat(Math.max(0, Math.floor((now - startedAt) / 1000)));
        }
      }, heartbeatMs);
    }
    child.on('error', (error) => finish(error));
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      lastStdoutAt = Date.now();
      if (resetTimeoutOnOutput) armTimeout();
      if (!onStdoutLine) return;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) onStdoutLine(line.trim());
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      if (onStdoutLine && stdoutBuffer.trim()) onStdoutLine(stdoutBuffer.trim());
      finish(terminationError, { code: code ?? 0, stdout, stderr });
    });
    if (!signal?.aborted) {
      if (input) child.stdin.write(input, 'utf8');
      child.stdin.end();
    }
  });
}

function recordCodexDiagnostic(event, data = {}, level = 'info', error = null, durationMs = undefined) {
  const method = ['debug', 'info', 'warn', 'error', 'fatal'].includes(level) ? level : 'info';
  codexLogger[method](event, {
    message: event,
    data,
    error: error || undefined,
    durationMs,
  });
}
