#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

const PYTHON_VERSION = '3.12.10';
const PYTHON_ABI = 'cp312';
const PYTHON_EMBED_SHA256 = '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3';
const PYTHON_EMBED_FILE = `python-${PYTHON_VERSION}-embed-amd64.zip`;
const PYTHON_EMBED_URLS = [
  `https://www.python.org/ftp/python/${PYTHON_VERSION}/${PYTHON_EMBED_FILE}`,
  `https://registry.npmmirror.com/-/binary/python/${PYTHON_VERSION}/${PYTHON_EMBED_FILE}`,
  `https://mirrors.huaweicloud.com/python/${PYTHON_VERSION}/${PYTHON_EMBED_FILE}`,
];
const PPT_PACKAGES = Object.freeze([
  'python-pptx==1.0.2',
  'Pillow==11.3.0',
  'PyMuPDF==1.26.3',
  'lxml==6.1.1',
  'typing-extensions==4.16.0',
  'XlsxWriter==3.2.9',
]);
const RUNTIME_SCHEMA_VERSION = 1;

const projectRoot = path.resolve(argumentValue('--root', process.cwd()));
const runtimeRoot = path.resolve(argumentValue('--output', path.join(projectRoot, 'build-runtime', 'windows-x64', 'python')));
const buildRoot = path.dirname(runtimeRoot);
const cacheRoot = path.join(projectRoot, 'build-runtime', '.cache');
const manifestPath = path.join(runtimeRoot, 'janus-runtime.json');

if (await runtimeReady(manifestPath)) {
  process.stdout.write(`Windows Python runtime is ready: ${runtimeRoot}\n`);
  process.exit(0);
}

const buildPython = resolveBuildPython();
const archivePath = path.join(cacheRoot, PYTHON_EMBED_FILE);
await fsp.mkdir(cacheRoot, { recursive: true });
if (!await fileMatchesSha256(archivePath, PYTHON_EMBED_SHA256)) {
  await fsp.rm(archivePath, { force: true });
  await downloadVerifiedArchive(archivePath);
}

await fsp.mkdir(buildRoot, { recursive: true });
const temporaryRoot = path.join(buildRoot, `.python-runtime-${process.pid}-${Date.now()}`);
await fsp.rm(temporaryRoot, { recursive: true, force: true });
await fsp.mkdir(temporaryRoot, { recursive: true });

try {
  runBuildPython(buildPython, ['-m', 'zipfile', '-e', archivePath, temporaryRoot]);
  const sitePackages = path.join(temporaryRoot, 'Lib', 'site-packages');
  await fsp.mkdir(sitePackages, { recursive: true });
  runBuildPython(buildPython, [
    '-m', 'pip', 'install',
    '--disable-pip-version-check',
    '--no-compile',
    '--no-deps',
    '--only-binary=:all:',
    '--platform', 'win_amd64',
    '--python-version', '3.12',
    '--implementation', 'cp',
    '--abi', PYTHON_ABI,
    '--target', sitePackages,
    ...PPT_PACKAGES,
  ]);
  await configureEmbeddedPath(temporaryRoot);
  await removeBytecode(temporaryRoot);
  const manifest = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    platform: 'win32',
    arch: 'x64',
    pythonVersion: PYTHON_VERSION,
    pythonAbi: PYTHON_ABI,
    pythonArchive: PYTHON_EMBED_FILE,
    pythonArchiveSha256: PYTHON_EMBED_SHA256,
    packages: PPT_PACKAGES,
  };
  await fsp.writeFile(path.join(temporaryRoot, 'janus-runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await assertRuntimeFiles(temporaryRoot);
  await fsp.rm(runtimeRoot, { recursive: true, force: true });
  await fsp.rename(temporaryRoot, runtimeRoot);
  process.stdout.write(`Prepared Windows Python ${PYTHON_VERSION} PPT runtime at ${runtimeRoot}\n`);
} catch (error) {
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
  throw error;
}

async function runtimeReady(candidateManifestPath) {
  if (!fs.existsSync(candidateManifestPath)) return false;
  try {
    const manifest = JSON.parse(await fsp.readFile(candidateManifestPath, 'utf8'));
    if (manifest.schemaVersion !== RUNTIME_SCHEMA_VERSION
      || manifest.pythonVersion !== PYTHON_VERSION
      || manifest.pythonArchiveSha256 !== PYTHON_EMBED_SHA256
      || JSON.stringify(manifest.packages) !== JSON.stringify(PPT_PACKAGES)) return false;
    await assertRuntimeFiles(path.dirname(candidateManifestPath));
    return true;
  } catch {
    return false;
  }
}

async function assertRuntimeFiles(root) {
  const required = [
    'python.exe',
    'python312.dll',
    'python312.zip',
    'python312._pth',
    path.join('Lib', 'site-packages', 'pptx', '__init__.py'),
    path.join('Lib', 'site-packages', 'PIL', '__init__.py'),
    path.join('Lib', 'site-packages', 'PIL', '_imaging.cp312-win_amd64.pyd'),
    path.join('Lib', 'site-packages', 'fitz', '__init__.py'),
    path.join('Lib', 'site-packages', 'pymupdf', '_mupdf.pyd'),
    path.join('Lib', 'site-packages', 'lxml', 'etree.cp312-win_amd64.pyd'),
  ];
  const missing = required.filter((relative) => !fs.existsSync(path.join(root, relative)));
  if (missing.length) throw new Error(`Windows Python runtime is incomplete: ${missing.join(', ')}`);
}

async function configureEmbeddedPath(root) {
  const pthPath = path.join(root, 'python312._pth');
  if (!fs.existsSync(pthPath)) throw new Error('Embedded Python path configuration is missing.');
  await fsp.writeFile(pthPath, [
    'python312.zip',
    '.',
    'Lib',
    'Lib\\site-packages',
    'import site',
    '',
  ].join('\r\n'), 'utf8');
}

async function removeBytecode(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') await fsp.rm(target, { recursive: true, force: true });
      else await removeBytecode(target);
    } else if (entry.isFile() && /\.py[co]$/i.test(entry.name)) {
      await fsp.rm(target, { force: true });
    }
  }
}

async function downloadVerifiedArchive(target) {
  const partial = `${target}.partial-${process.pid}`;
  let lastError = null;
  for (const url of PYTHON_EMBED_URLS) {
    try {
      await fsp.rm(partial, { force: true });
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(120_000),
        headers: { 'user-agent': 'Janus-Windows-Runtime-Builder/1.0' },
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial, { mode: 0o600 }));
      if (!await fileMatchesSha256(partial, PYTHON_EMBED_SHA256)) {
        throw new Error(`SHA-256 mismatch for ${url}`);
      }
      await fsp.rename(partial, target);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  await fsp.rm(partial, { force: true });
  throw new Error(`Unable to download verified Windows Python runtime: ${lastError?.message || lastError || 'unknown error'}`);
}

async function fileMatchesSha256(file, expected) {
  if (!fs.existsSync(file)) return false;
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex') === expected;
}

function resolveBuildPython() {
  const configured = String(process.env.JANUS_BUILD_PYTHON || '').trim();
  const candidates = configured
    ? [{ command: configured, prefixArgs: [] }]
    : process.platform === 'win32'
      ? [{ command: 'python', prefixArgs: [] }, { command: 'py', prefixArgs: ['-3'] }, { command: 'python3', prefixArgs: [] }]
      : [{ command: 'python3', prefixArgs: [] }, { command: 'python', prefixArgs: [] }];
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.prefixArgs, '--version'], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error('A build-time Python with pip is required to assemble the Windows embedded runtime.');
}

function runBuildPython(invocation, args) {
  const result = spawnSync(invocation.command, [...invocation.prefixArgs, ...args], {
    cwd: projectRoot,
    env: { ...process.env, PYTHONUTF8: '1' },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Build Python exited with code ${result.status}`);
}

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}
