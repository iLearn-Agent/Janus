#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cloudHome = path.resolve(process.env.JANUS_CLOUD_HOME || '/path/to/janus-cloud');
const incomingRoot = path.join(cloudHome, 'incoming');
const version = argumentValue('--version');
const requestedOutput = path.resolve(argumentValue('--output', path.join(incomingRoot, `windows-stable-${version}-local`)));
const electronDist = String(process.env.JANUS_ELECTRON_DIST || '').trim();
const packagedCloudUrl = String(process.env.JANUS_PACKAGED_CLOUD_URL || 'http://your-janus.example').trim().replace(/\/+$/, '');
const signingKey = path.resolve(process.env.JANUS_RELEASE_SIGNING_KEY || path.join(cloudHome, 'release-signing-private.pem'));
const snapshotRoot = path.join(projectRoot, '.codex-tmp', `windows-release-snapshot-${process.pid}`);
const stagingOutput = path.join(projectRoot, '.codex-tmp', `windows-release-output-${process.pid}`);
const snapshotEntries = [
  'src', 'network', 'assets', 'deploy', 'package.json',
  'scripts/prepare_windows_python_runtime.mjs', 'scripts/prepare_trial_provider_bundle.mjs',
  'scripts/lib/trialProviderDevEnv.mjs',
];
const sourceCommit = String(process.env.JANUS_SOURCE_COMMIT || gitOutput(['rev-parse', 'HEAD'])).trim();
const sourceTree = String(process.env.JANUS_SOURCE_TREE || gitOutput(['rev-parse', 'HEAD^{tree}'])).trim();

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid Windows release version: ${version}`);
if (!requestedOutput.startsWith(`${incomingRoot}${path.sep}`)) throw new Error(`Windows release output must be under ${incomingRoot}`);
if (!/^https?:\/\/[^\s/$.?#].*$/i.test(packagedCloudUrl)) throw new Error(`Invalid packaged cloud URL: ${packagedCloudUrl}`);
if (!fs.existsSync(signingKey)) throw new Error(`Janus release signing key is missing: ${signingKey}`);
if (fs.existsSync(requestedOutput) && fs.readdirSync(requestedOutput).length) throw new Error(`Windows release output already exists: ${requestedOutput}`);

await fsp.mkdir(path.dirname(snapshotRoot), { recursive: true });
await fsp.mkdir(incomingRoot, { recursive: true });
await fsp.rm(snapshotRoot, { recursive: true, force: true });
await fsp.rm(stagingOutput, { recursive: true, force: true });

let completed = false;
try {
  await createVerifiedSnapshot();
  await applySnapshotVersion();
  await writePackagedCloudDefaults();
  run(process.execPath, [path.join(projectRoot, 'scripts', 'prepare_windows_python_runtime.mjs'), '--root', projectRoot], { cwd: projectRoot });
  await fsp.cp(path.join(projectRoot, 'build-runtime', 'windows-x64', 'python'),
    path.join(snapshotRoot, 'build-runtime', 'windows-x64', 'python'), { recursive: true, preserveTimestamps: true });
  if (!fs.existsSync(path.join(projectRoot, 'node_modules'))) throw new Error('node_modules is missing; install dependencies before building.');
  await fsp.cp(path.join(projectRoot, 'node_modules'), path.join(snapshotRoot, 'node_modules'), {
    recursive: true, preserveTimestamps: true, mode: fs.constants.COPYFILE_FICLONE,
  });

  const builder = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  run(builder, [
    '--win', 'nsis', '--x64', '--publish', 'never',
    '--config', 'deploy/electron-builder.windows.cjs',
    `--config.directories.output=${stagingOutput}`,
    ...(electronDist ? [`--config.electronDist=${path.resolve(electronDist)}`] : []),
  ], {
    cwd: snapshotRoot,
    shell: process.platform === 'win32',
    env: { ...process.env, JANUS_SOURCE_COMMIT: sourceCommit, JANUS_SOURCE_TREE: sourceTree },
  });

  run(process.execPath, [path.join(projectRoot, 'scripts', 'sign_desktop_update.mjs'),
    '--platform', 'windows', '--dist', stagingOutput, '--private-key', signingKey], { cwd: projectRoot });
  run(process.execPath, [path.join(projectRoot, 'scripts', 'verify_packaged_app.mjs'),
    '--app-dir', path.join(stagingOutput, 'win-unpacked'), '--expected-channel', 'stable',
    '--expected-cloud-url', packagedCloudUrl, '--expected-version', version,
    '--expected-source-commit', sourceCommit], { cwd: projectRoot });
  run(process.execPath, [path.join(projectRoot, 'scripts', 'verify_windows_python_runtime.mjs'),
    '--app-dir', path.join(stagingOutput, 'win-unpacked')], { cwd: projectRoot });

  const installer = `Janus Setup ${version}.exe`;
  run(process.execPath, [path.join(projectRoot, 'scripts', 'verify_windows_authenticode.mjs'), '--expect-unsigned',
    '--file', path.join(stagingOutput, installer), '--file', path.join(stagingOutput, 'win-unpacked', 'Janus.exe')], { cwd: projectRoot });

  await fsp.mkdir(requestedOutput, { recursive: true });
  for (const name of [installer, `${installer}.blockmap`, 'latest.yml']) {
    const source = path.join(stagingOutput, name);
    if (!fs.existsSync(source)) throw new Error(`Windows release artifact is missing: ${name}`);
    await fsp.copyFile(source, path.join(requestedOutput, name));
  }
  completed = true;
  process.stdout.write(`${JSON.stringify({ status: 'built', version, output: requestedOutput, packagedCloudUrl }, null, 2)}\n`);
} finally {
  await fsp.rm(snapshotRoot, { recursive: true, force: true });
  if (completed) await fsp.rm(stagingOutput, { recursive: true, force: true });
  else if (fs.existsSync(stagingOutput)) process.stderr.write(`Windows build staging preserved for diagnosis: ${stagingOutput}\n`);
}

async function createVerifiedSnapshot() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await fsp.rm(snapshotRoot, { recursive: true, force: true });
    await fsp.mkdir(snapshotRoot, { recursive: true });
    for (const entry of snapshotEntries) {
      const source = path.join(projectRoot, entry);
      if (!fs.existsSync(source)) throw new Error(`Required Windows build input is missing: ${entry}`);
      await fsp.cp(source, path.join(snapshotRoot, entry), { recursive: true, preserveTimestamps: true });
    }
    const [sourceManifest, snapshotManifest] = await Promise.all([
      treeManifest(projectRoot, snapshotEntries), treeManifest(snapshotRoot, snapshotEntries),
    ]);
    if (sourceManifest === snapshotManifest) {
      process.stdout.write(`Created stable production Windows snapshot on attempt ${attempt}.\n`);
      return;
    }
    process.stderr.write(`Windows build inputs changed during snapshot attempt ${attempt}; retrying.\n`);
  }
  throw new Error('Windows build inputs kept changing. Stop active edits and retry.');
}

async function applySnapshotVersion() {
  const packagePath = path.join(snapshotRoot, 'package.json');
  const packageJson = JSON.parse(await fsp.readFile(packagePath, 'utf8'));
  packageJson.version = version;
  await fsp.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
}

async function writePackagedCloudDefaults() {
  const target = path.join(snapshotRoot, 'assets', 'cloud-sync-defaults.json');
  await fsp.writeFile(target, `${JSON.stringify({ serverUrl: packagedCloudUrl, autoSync: true }, null, 2)}\n`, 'utf8');
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
    for (const entry of await fsp.readdir(target, { withFileTypes: true })) {
      await appendManifest(path.join(target, entry.name), path.join(relative, entry.name), records);
    }
    return;
  }
  if (!stat.isFile()) return;
  records.push(`file:${relative}:${stat.size}:${crypto.createHash('sha256').update(await fsp.readFile(target)).digest('hex')}`);
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

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}
