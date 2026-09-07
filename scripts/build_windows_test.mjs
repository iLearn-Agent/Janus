#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(projectRoot, 'test-artifacts');
const requestedVersion = argumentValue('--version', '');
const requestedOutput = argumentValue('--output', '');
const electronDist = String(process.env.JANUS_ELECTRON_DIST || '').trim();
const snapshotRoot = path.join(artifactRoot, `.windows-test-snapshot-${process.pid}`);
const stagingOutput = path.join(artifactRoot, `.windows-test-output-${process.pid}`);
const finalOutput = resolveFinalOutput(requestedOutput);
const snapshotEntries = [
  'src', 'network', 'assets', 'deploy', 'package.json',
  'scripts/prepare_windows_python_runtime.mjs', 'scripts/prepare_trial_provider_bundle.mjs',
  'scripts/lib/trialProviderDevEnv.mjs',
];
const packagedCloudUrl = publicPackagedCloudUrl();
const sourceCommit = String(process.env.JANUS_SOURCE_COMMIT || gitOutput(['rev-parse', 'HEAD'])).trim();
const configuredSourceTree = String(process.env.JANUS_SOURCE_TREE || '').trim();
let sourceTree = configuredSourceTree || gitOutput(['rev-parse', 'HEAD^{tree}']).trim();

await fsp.mkdir(artifactRoot, { recursive: true });
await fsp.rm(snapshotRoot, { recursive: true, force: true });
await fsp.rm(stagingOutput, { recursive: true, force: true });

let promoted = false;
try {
  await createVerifiedSnapshot();
  if (requestedVersion) await applySnapshotVersion(requestedVersion);
  run(process.execPath, [
    path.join(projectRoot, 'scripts', 'prepare_windows_python_runtime.mjs'),
    '--root', projectRoot,
  ], { cwd: projectRoot });
  await fsp.cp(
    path.join(projectRoot, 'build-runtime', 'windows-x64', 'python'),
    path.join(snapshotRoot, 'build-runtime', 'windows-x64', 'python'),
    { recursive: true, preserveTimestamps: true, mode: fs.constants.COPYFILE_FICLONE },
  );
  const nodeModulesSource = path.join(projectRoot, 'node_modules');
  if (!fs.existsSync(nodeModulesSource)) throw new Error('node_modules is missing; install dependencies before building.');
  await fsp.cp(nodeModulesSource, path.join(snapshotRoot, 'node_modules'), {
    recursive: true,
    preserveTimestamps: true,
    mode: fs.constants.COPYFILE_FICLONE,
  });

  const builder = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  run(builder, [
    '--win',
    'nsis',
    '--x64',
    '--publish',
    'never',
    '--config',
    'deploy/electron-builder.windows.test.cjs',
    `--config.directories.output=${stagingOutput}`,
    ...(electronDist ? [`--config.electronDist=${path.resolve(electronDist)}`] : []),
  ], {
    cwd: snapshotRoot,
    shell: process.platform === 'win32',
    env: { ...process.env, JANUS_SOURCE_COMMIT: sourceCommit, JANUS_SOURCE_TREE: sourceTree },
  });

  run(process.execPath, [
    path.join(projectRoot, 'scripts', 'verify_packaged_app.mjs'),
    '--app-dir',
    path.join(stagingOutput, 'win-unpacked'),
    '--expected-channel',
    'test',
    '--expected-cloud-url',
    packagedCloudUrl,
    '--expected-platform',
    'win32',
    '--expected-source-commit',
    sourceCommit,
    ...(requestedVersion ? ['--expected-version', requestedVersion] : []),
  ], { cwd: projectRoot });
  run(process.execPath, [
    path.join(projectRoot, 'scripts', 'verify_windows_python_runtime.mjs'),
    '--app-dir',
    path.join(stagingOutput, 'win-unpacked'),
  ], { cwd: projectRoot });
  const trialProviderBundle = path.join(stagingOutput, 'win-unpacked', 'resources', 'trial-provider', 'provider.enc');
  if (!fs.existsSync(trialProviderBundle)) throw new Error('Windows test package is missing the trial Provider bundle.');

  await fsp.rm(finalOutput, { recursive: true, force: true });
  await fsp.rename(stagingOutput, finalOutput);
  promoted = true;
  process.stdout.write(`Verified Windows test artifacts promoted to ${finalOutput}\n`);
} finally {
  await fsp.rm(snapshotRoot, { recursive: true, force: true });
  if (promoted) {
    await fsp.rm(stagingOutput, { recursive: true, force: true });
  } else if (fs.existsSync(stagingOutput)) {
    process.stderr.write(`Windows test build failed; preserving staged artifacts for diagnosis at ${stagingOutput}\n`);
  }
}

async function applySnapshotVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid Windows test package version: ${version}`);
  }
  const packagePath = path.join(snapshotRoot, 'package.json');
  const packageJson = JSON.parse(await fsp.readFile(packagePath, 'utf8'));
  packageJson.version = version;
  await fsp.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  process.stdout.write(`Applied Windows test snapshot version ${version}.\n`);
}

async function createVerifiedSnapshot() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await fsp.rm(snapshotRoot, { recursive: true, force: true });
    await fsp.mkdir(snapshotRoot, { recursive: true });
    for (const entry of snapshotEntries) {
      const source = path.join(projectRoot, entry);
      const target = path.join(snapshotRoot, entry);
      if (!fs.existsSync(source)) throw new Error(`Required build input is missing: ${entry}`);
      await fsp.cp(source, target, { recursive: true, preserveTimestamps: true });
    }
    const [sourceManifest, snapshotManifest] = await Promise.all([
      treeManifest(projectRoot, snapshotEntries),
      treeManifest(snapshotRoot, snapshotEntries),
    ]);
    if (sourceManifest === snapshotManifest) {
      if (!configuredSourceTree) sourceTree = sourceManifest;
      process.stdout.write(`Created stable Windows build snapshot on attempt ${attempt}.\n`);
      return;
    }
    process.stderr.write(`Build inputs changed while snapshot attempt ${attempt} was being created; retrying.\n`);
  }
  throw new Error('Build inputs kept changing while creating the Windows snapshot. Stop active edits and retry.');
}

async function treeManifest(root, entries) {
  const records = [];
  for (const entry of entries) await appendManifest(path.join(root, entry), entry, records);
  return crypto.createHash('sha256').update(records.sort().join('\n')).digest('hex');
}

async function appendManifest(target, relative, records) {
  const stat = await fsp.lstat(target);
  if (stat.isSymbolicLink()) {
    records.push(`link:${relative}:${await fsp.readlink(target)}`);
    return;
  }
  if (stat.isDirectory()) {
    const entries = await fsp.readdir(target, { withFileTypes: true });
    for (const entry of entries) await appendManifest(path.join(target, entry.name), path.join(relative, entry.name), records);
    return;
  }
  if (!stat.isFile()) return;
  const digest = crypto.createHash('sha256').update(await fsp.readFile(target)).digest('hex');
  records.push(`file:${relative}:${stat.size}:${digest}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with code ${result.status}`);
}

function gitOutput(args) {
  const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Unable to resolve source identity from Git: ${String(result.stderr || '').trim()}`);
  return String(result.stdout || '').trim();
}

function publicPackagedCloudUrl() {
  const defaults = JSON.parse(fs.readFileSync(path.join(projectRoot, 'assets', 'auth-defaults.json'), 'utf8'));
  const value = String(defaults.serverUrl || '').trim().replace(/\/+$/g, '');
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || !hostname
    || hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')) {
    throw new Error(`Windows test packages require a public cloud URL, received ${value || '(empty)'}.`);
  }
  return value;
}

function resolveFinalOutput(value = '') {
  const target = value ? path.resolve(projectRoot, value) : path.join(artifactRoot, 'windows');
  const relative = path.relative(artifactRoot, target);
  if (!relative || relative === '.' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Windows test output must be a named directory under ${artifactRoot}.`);
  }
  return target;
}

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}
