#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { extractAll } = require('@electron/asar');
const MINIMUM_CODEX_PLUGIN_VERSION = '0.144.3';

const appDir = path.resolve(argumentValue('--app-dir'));
const expectedChannel = argumentValue('--expected-channel', '');
const expectedCloudUrl = argumentValue('--expected-cloud-url', '');
const expectedVersion = argumentValue('--expected-version', '');
const expectedSourceCommit = argumentValue('--expected-source-commit', '');
const expectedPlatform = argumentValue('--expected-platform', '');
const resourcesDir = path.join(appDir, 'resources');
const asarPath = path.join(resourcesDir, 'app.asar');
const looseAppDir = path.join(resourcesDir, 'app');
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'janus-packaged-app-check-'));

try {
  let packagedRoot = looseAppDir;
  if (fs.existsSync(asarPath)) {
    packagedRoot = path.join(temporaryRoot, 'app');
    extractAll(asarPath, packagedRoot);
  } else if (!fs.existsSync(looseAppDir)) {
    throw new Error(`Packaged application payload is missing under ${resourcesDir}`);
  }

  const packagePath = path.join(packagedRoot, 'package.json');
  if (!fs.existsSync(packagePath)) throw new Error('Packaged package.json is missing.');
  const packageJson = JSON.parse(await fsp.readFile(packagePath, 'utf8'));
  if (expectedVersion && packageJson.version !== expectedVersion) {
    throw new Error(`Packaged version ${packageJson.version || '(empty)'} does not match expected version ${expectedVersion}.`);
  }
  const sourceCommit = String(packageJson.janusSourceCommit || '').trim();
  const sourceTree = String(packageJson.janusSourceTree || '').trim();
  if (!sourceCommit) throw new Error('Packaged source identity is missing; refusing to verify an untraceable build.');
  if (expectedSourceCommit && sourceCommit !== expectedSourceCommit) {
    throw new Error(`Packaged source commit ${sourceCommit} does not match expected ${expectedSourceCommit}.`);
  }
  const channel = packageJson.janusDesktopReleaseChannel
    || (packageJson.name === 'janus-test' || packageJson.productName === 'Janus Test' ? 'test' : 'stable');
  if (expectedChannel && channel !== expectedChannel) {
    throw new Error(`Packaged release channel ${channel} does not match expected channel ${expectedChannel}.`);
  }
  const authDefaultsPath = path.join(packagedRoot, 'assets', 'auth-defaults.json');
  if (!fs.existsSync(authDefaultsPath)) throw new Error('Packaged authentication defaults are missing.');
  const authDefaults = JSON.parse(await fsp.readFile(authDefaultsPath, 'utf8'));
  const cloudServerUrl = String(authDefaults.serverUrl || '').trim().replace(/\/+$/g, '');
  if (expectedCloudUrl && cloudServerUrl !== String(expectedCloudUrl).trim().replace(/\/+$/g, '')) {
    throw new Error(`Packaged cloud URL ${cloudServerUrl || '(empty)'} does not match expected URL ${expectedCloudUrl}.`);
  }
  const runtimeDependenciesChecked = await verifyRuntimeDependencies(packagedRoot, packageJson);
  const platform = expectedPlatform || inferPackagedPlatform(packagedRoot);
  if (!['win32', 'linux', 'darwin'].includes(platform)) throw new Error(`Unable to determine packaged desktop platform: ${platform || '(empty)'}`);
  const packagedPython = platform === 'win32' ? verifyPackagedWindowsPython(resourcesDir) : '';

  for (const requiredFile of ['src/main/main.js', 'src/preload/preload.js', 'src/renderer/app.js']) {
    if (!fs.existsSync(path.join(packagedRoot, requiredFile))) {
      throw new Error(`Required packaged module is missing: ${requiredFile}`);
    }
  }

  const syntaxRoots = ['src', 'network']
    .map((entry) => path.join(packagedRoot, entry))
    .filter((entry) => fs.existsSync(entry));
  const syntaxFiles = [];
  for (const root of syntaxRoots) await collectJavaScriptFiles(root, syntaxFiles);
  const codexLoader = path.join(packagedRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (!fs.existsSync(codexLoader)) throw new Error('Packaged Codex JavaScript loader is missing.');
  syntaxFiles.push(codexLoader);
  const codexPackage = platform === 'win32'
    ? 'codex-win32-x64'
    : platform === 'darwin'
      ? 'codex-darwin-arm64'
      : 'codex-linux-x64';
  const codexExecutable = await findNamedFile(
    path.join(packagedRoot, 'node_modules', '@openai', codexPackage),
    platform === 'win32' ? 'codex.exe' : 'codex',
  );
  if (!codexExecutable) throw new Error(`Packaged ${platform} Codex executable is missing.`);
  const codexRuntimeExecutable = resolveRuntimeExecutable(codexExecutable, packagedRoot, resourcesDir);
  const codexVersion = verifyPackagedCodexPluginRuntime(codexRuntimeExecutable, platform);

  const failures = [];
  for (const file of syntaxFiles.sort()) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) continue;
    failures.push({
      file: path.relative(packagedRoot, file),
      detail: String(result.stderr || result.stdout || `node --check exited with ${result.status}`).trim(),
    });
    if (failures.length >= 20) break;
  }
  if (failures.length) {
    const detail = failures.map((failure) => `${failure.file}\n${failure.detail}`).join('\n\n');
    throw new Error(`Packaged JavaScript syntax verification failed:\n${detail}`);
  }

  process.stdout.write(`${JSON.stringify({
    status: 'verified',
    appDir,
    packageName: packageJson.name,
    productName: packageJson.productName || '',
    version: packageJson.version,
    sourceCommit,
    sourceTree,
    platform,
    channel,
    cloudServerUrl,
    javascriptFilesChecked: syntaxFiles.length,
    runtimeDependenciesChecked,
    codexExecutable: path.relative(packagedRoot, codexExecutable),
    codexVersion,
    pythonExecutable: packagedPython ? path.relative(appDir, packagedPython) : '',
  }, null, 2)}\n`);
} finally {
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}

function resolveRuntimeExecutable(executable, packagedRoot, resourcesDir) {
  const unpackedExecutable = path.join(resourcesDir, 'app.asar.unpacked', path.relative(packagedRoot, executable));
  return fs.existsSync(unpackedExecutable) ? unpackedExecutable : executable;
}

function verifyPackagedCodexPluginRuntime(codexExecutable, platform) {
  const execution = resolveExecutableExecution(codexExecutable, platform);
  const versionResult = runExecutable(execution, ['--version']);
  if (versionResult.error || versionResult.status !== 0) {
    const detail = String(versionResult.error?.message || versionResult.stderr || versionResult.stdout || `exit ${versionResult.status}`).trim();
    throw new Error(`Packaged Codex executable could not report its version: ${detail}`);
  }
  const versionOutput = `${versionResult.stdout || ''}\n${versionResult.stderr || ''}`;
  const codexVersion = versionOutput.match(/(?:^|\s)(\d+\.\d+\.\d+)(?:[-+\s]|$)/)?.[1] || '';
  if (!codexVersion) throw new Error(`Packaged Codex returned an unrecognized version: ${versionOutput.trim()}`);
  if (compareVersions(codexVersion, MINIMUM_CODEX_PLUGIN_VERSION) < 0) {
    throw new Error(`Packaged Codex ${codexVersion} is too old for plugins; ${MINIMUM_CODEX_PLUGIN_VERSION} or newer is required.`);
  }
  const helpResult = runExecutable(execution, ['plugin', '--help']);
  const help = `${helpResult.stdout || ''}\n${helpResult.stderr || ''}`;
  if (helpResult.error || helpResult.status !== 0) {
    const detail = String(helpResult.error?.message || help || `exit ${helpResult.status}`).trim();
    throw new Error(`Packaged Codex plugin command is unavailable: ${detail}`);
  }
  const missingCommands = ['add', 'list', 'remove'].filter((command) => !new RegExp(`^\\s*${command}\\s+`, 'mi').test(help));
  if (missingCommands.length) {
    throw new Error(`Packaged Codex plugin command is incomplete; missing: ${missingCommands.join(', ')}.`);
  }
  return codexVersion;
}

function resolveExecutableExecution(executable, platform) {
  if (platform !== 'win32' || process.platform === 'win32') {
    return { command: executable, prefixArgs: [], env: process.env };
  }
  const wine = commandPath('wine64') || commandPath('wine');
  if (!wine) throw new Error('Wine is required to verify a packaged Windows Codex runtime on this host.');
  return { command: wine, prefixArgs: [executable], env: { ...process.env, WINEDEBUG: '-all' } };
}

function runExecutable(execution, args) {
  return spawnSync(execution.command, [...execution.prefixArgs, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    env: execution.env,
  });
}

function commandPath(command) {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(locator, [command], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
  return result.status === 0 ? String(result.stdout || '').split(/\r?\n/)[0].trim() : '';
}

function compareVersions(left = '', right = '') {
  const a = String(left || '').split('.').map((item) => Number(item) || 0);
  const b = String(right || '').split('.').map((item) => Number(item) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}

function verifyPackagedWindowsPython(resourcesDir) {
  const runtimeRoot = path.join(resourcesDir, 'python');
  const required = [
    path.join(runtimeRoot, 'python.exe'),
    path.join(runtimeRoot, 'python312.dll'),
    path.join(runtimeRoot, 'python312.zip'),
    path.join(runtimeRoot, 'python312._pth'),
    path.join(runtimeRoot, 'Lib', 'site-packages', 'pptx', '__init__.py'),
    path.join(runtimeRoot, 'Lib', 'site-packages', 'PIL', '__init__.py'),
    path.join(runtimeRoot, 'Lib', 'site-packages', 'PIL', '_imaging.cp312-win_amd64.pyd'),
    path.join(runtimeRoot, 'Lib', 'site-packages', 'fitz', '__init__.py'),
    path.join(runtimeRoot, 'Lib', 'site-packages', 'pymupdf', '_mupdf.pyd'),
    path.join(runtimeRoot, 'Lib', 'site-packages', 'lxml', 'etree.cp312-win_amd64.pyd'),
    path.join(runtimeRoot, 'janus-runtime.json'),
  ];
  const missing = required.filter((file) => !fs.existsSync(file));
  if (missing.length) throw new Error(`Packaged Windows Python/PPT runtime is missing:\n${missing.join('\n')}`);
  return required[0];
}

function inferPackagedPlatform(packagedRoot) {
  const openaiRoot = path.join(packagedRoot, 'node_modules', '@openai');
  if (fs.existsSync(path.join(openaiRoot, 'codex-win32-x64'))) return 'win32';
  if (fs.existsSync(path.join(openaiRoot, 'codex-linux-x64'))) return 'linux';
  if (fs.existsSync(path.join(openaiRoot, 'codex-darwin-arm64'))) return 'darwin';
  return '';
}

async function collectJavaScriptFiles(directory, output) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectJavaScriptFiles(target, output);
    } else if (entry.isFile() && /\.(?:c|m)?js$/i.test(entry.name)) {
      output.push(target);
    }
  }
}

async function verifyRuntimeDependencies(packagedRoot, packageJson) {
  const queue = Object.keys(packageJson.dependencies || {}).map((name) => ({
    name,
    fromDirectory: packagedRoot,
    requiredBy: packageJson.name || 'application',
  }));
  const visited = new Set();
  const missing = [];
  while (queue.length) {
    const dependency = queue.shift();
    const packagePath = await resolveDependencyPackage(packagedRoot, dependency.fromDirectory, dependency.name);
    if (!packagePath) {
      missing.push(`${dependency.name} (required by ${dependency.requiredBy})`);
      continue;
    }
    const canonicalPath = await fsp.realpath(packagePath);
    if (visited.has(canonicalPath)) continue;
    visited.add(canonicalPath);
    const dependencyPackage = JSON.parse(await fsp.readFile(packagePath, 'utf8'));
    const dependencyRoot = path.dirname(packagePath);
    for (const name of Object.keys(dependencyPackage.dependencies || {})) {
      queue.push({ name, fromDirectory: dependencyRoot, requiredBy: dependencyPackage.name || dependency.name });
    }
  }
  if (missing.length) {
    throw new Error(`Packaged runtime dependencies are missing:\n${missing.sort().join('\n')}`);
  }
  return visited.size;
}

async function resolveDependencyPackage(packagedRoot, fromDirectory, dependencyName) {
  let cursor = path.resolve(fromDirectory);
  const boundary = path.resolve(packagedRoot);
  while (cursor === boundary || cursor.startsWith(`${boundary}${path.sep}`)) {
    const candidate = path.join(cursor, 'node_modules', ...dependencyName.split('/'), 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    if (cursor === boundary) break;
    cursor = path.dirname(cursor);
  }
  return '';
}

async function findNamedFile(directory, name) {
  if (!fs.existsSync(directory)) return '';
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findNamedFile(target, name);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) {
      return target;
    }
  }
  return '';
}

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}
