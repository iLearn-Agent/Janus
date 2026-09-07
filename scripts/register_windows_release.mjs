#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { insertReleaseManifest } from '../src/cloud/releasePublisher.js';
import { normalizeReleaseVersion, releaseArtifactUrl, versionReleaseManifest } from '../src/shared/releaseLayout.js';
import { checksumsEqual, readUpdateSignatureManifest, verifyUpdateMetadata } from '../src/shared/updateSignature.js';
import { prunePlatformReleaseDirectories } from '../src/shared/releaseRetention.js';
import { promoteUnifiedDesktopFeeds } from '../src/shared/unifiedDesktopRelease.js';
import { verifyWindowsAuthenticode, verifyWindowsUnsigned } from './verify_windows_authenticode.mjs';

const cloudHome = process.env.JANUS_CLOUD_HOME || '/path/to/janus-cloud';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = normalizeReleaseVersion(argumentValue('--version'));
const incomingDir = path.resolve(argumentValue('--incoming'));
const incomingRoot = path.resolve(cloudHome, 'incoming');
const releasesDirectory = releaseDirectory(argumentValue('--releases-dir', 'releases'));
const windowsPublisherName = String(process.env.JANUS_WINDOWS_PUBLISHER_NAME || '').trim();
const allowUnsigned = process.argv.includes('--allow-unsigned') || truthy(process.env.JANUS_ALLOW_UNSIGNED_WINDOWS_RELEASE);

if (!windowsPublisherName && !allowUnsigned) {
  throw new Error('JANUS_WINDOWS_PUBLISHER_NAME is required unless --allow-unsigned is explicitly set.');
}

if (!incomingDir.startsWith(`${incomingRoot}${path.sep}`)) {
  throw new Error(`Windows release input must be under ${incomingRoot}`);
}
if (!fs.existsSync(incomingDir)) throw new Error(`Windows release input does not exist: ${incomingDir}`);

const names = fs.readdirSync(incomingDir).filter((name) => fs.statSync(path.join(incomingDir, name)).isFile());
const exeNames = names.filter((name) => name.endsWith('.exe'));
if (exeNames.length !== 1) throw new Error(`Expected exactly one Windows NSIS EXE, found ${exeNames.length}.`);
const expectedBlockmap = `${exeNames[0]}.blockmap`;
if (!names.includes(expectedBlockmap)) throw new Error(`Windows blockmap is missing: ${expectedBlockmap}`);
if (!names.includes('latest.yml')) throw new Error('latest.yml is missing from the Windows release input.');
const allowedNames = new Set([exeNames[0], expectedBlockmap, 'latest.yml']);
const unexpectedNames = names.filter((name) => !allowedNames.has(name));
if (unexpectedNames.length) throw new Error(`Unexpected Windows release files: ${unexpectedNames.join(', ')}`);

const sourceManifest = await fsp.readFile(path.join(incomingDir, 'latest.yml'), 'utf8');
const manifestVersion = sourceManifest.match(/^version:\s*['"]?([^'"\r\n]+)['"]?\s*$/m)?.[1]?.trim() || '';
if (manifestVersion !== version) throw new Error(`latest.yml version ${manifestVersion || '(missing)'} does not match ${version}.`);
const exePath = path.join(incomingDir, exeNames[0]);
const authenticode = windowsPublisherName
  ? { signed: true, ...verifyWindowsAuthenticode(exePath, { expectedPublisher: windowsPublisherName }) }
  : verifyWindowsUnsigned(exePath);
const exeBuffer = await fsp.readFile(exePath);
const manifestExe = manifestFileEntry(sourceManifest, '.exe');
const exeSha512 = crypto.createHash('sha512').update(exeBuffer).digest('base64');
if (
  !manifestExe
  || path.posix.basename(manifestExe.url) !== exeNames[0]
  || Number(manifestExe.size) !== exeBuffer.length
  || manifestExe.sha512 !== exeSha512
) {
  throw new Error('latest.yml EXE entry does not match the uploaded NSIS installer.');
}
const signedUpdate = readUpdateSignatureManifest(sourceManifest);
if (
  signedUpdate.metadata.version !== version
  || signedUpdate.metadata.file !== exeNames[0]
  || signedUpdate.metadata.size !== exeBuffer.length
  || !checksumsEqual(signedUpdate.metadata.sha512, exeSha512)
) {
  throw new Error('Signed Windows update metadata does not match the uploaded NSIS installer.');
}
const signingPublicKeyPath = process.env.JANUS_RELEASE_SIGNING_PUBLIC_KEY || path.join(projectRoot, 'assets', 'release-signing-public.pem');
verifyUpdateMetadata(signedUpdate.metadata, await fsp.readFile(signingPublicKeyPath, 'utf8'));

const releasesRoot = path.join(cloudHome, releasesDirectory, 'windows');
const targetDir = path.join(releasesRoot, version);
const targetExists = fs.existsSync(targetDir) && fs.readdirSync(targetDir).length;
const reuseTarget = targetExists && releaseTargetMatches({
  targetDir, incomingDir, names, manifestName: 'latest.yml', sourceManifest, version,
});
if (targetExists && !reuseTarget) throw new Error(`Windows release ${version} already exists and is immutable.`);

const stagingDir = path.join(releasesRoot, `.${version}.${process.pid}.tmp`);
if (!reuseTarget) {
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await fsp.mkdir(stagingDir, { recursive: true });
  try {
    for (const name of names) {
      const source = path.join(incomingDir, name);
      const target = path.join(stagingDir, name);
      if (name === 'latest.yml') {
        await fsp.writeFile(target, versionReleaseManifest(sourceManifest, version), 'utf8');
      } else {
        await fsp.copyFile(source, target);
      }
    }
    await fsp.rm(targetDir, { recursive: true, force: true });
    await fsp.rename(stagingDir, targetDir);
  } catch (error) {
    await fsp.rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

const artifacts = names.map((name) => artifactManifest(path.join(targetDir, name), {
  kind: name.endsWith('.exe') ? 'application_installer' : name === 'latest.yml' ? 'update_feed' : 'blockmap',
  url: releaseArtifactUrl(`windows/${version}/${name}`),
}));
const createdAt = new Date().toISOString();
const devManifest = {
  id: `dev-windows-${version}-${Date.now()}`,
  releaseType: 'application',
  channel: 'dev',
  version,
  createdAt,
  platform: 'win32',
  arch: 'x64',
  authenticode: { signed: Boolean(authenticode.signed), publisher: authenticode.publisher || '' },
  artifacts,
};
if (releasesDirectory === 'releases') {
  insertReleaseManifest(cloudHome, devManifest);
  insertReleaseManifest(cloudHome, {
    ...devManifest,
    id: `stable-windows-${version}-${Date.now()}`,
    channel: 'stable',
    promotedFrom: devManifest.id,
    promotedAt: new Date().toISOString(),
  });
}

const promotion = await promoteUnifiedDesktopFeeds(cloudHome, version, { releasesDirectory });
const retentionLimit = releasesDirectory === 'test_releases' ? 1 : 3;
const retention = await prunePlatformReleaseDirectories(releasesRoot, { keep: retentionLimit });
await fsp.rm(incomingDir, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ status: 'published', version, platform: 'win32', arch: 'x64', authenticode, targetDir, promotion, retention }, null, 2)}\n`);

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function releaseDirectory(value = '') {
  if (!['releases', 'test_releases'].includes(value)) throw new Error(`Unsupported releases directory: ${value}`);
  return value;
}

function truthy(value = '') {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function artifactManifest(file, overrides = {}) {
  const buffer = fs.readFileSync(file);
  return {
    name: path.basename(file),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    sha512: crypto.createHash('sha512').update(buffer).digest('base64'),
    sizeBytes: buffer.length,
    platform: 'win32',
    arch: 'x64',
    ...overrides,
  };
}

function manifestFileEntry(text, extension) {
  const lines = String(text || '').split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const url = line.match(/^\s*-\s+url:\s*['"]?(.+?)['"]?\s*$/);
    if (url) {
      if (current?.url?.toLowerCase().endsWith(extension)) return current;
      current = { url: url[1] };
      continue;
    }
    if (!current) continue;
    const sha = line.match(/^\s+sha512:\s*['"]?([^'"\s]+)['"]?\s*$/);
    if (sha) current.sha512 = sha[1];
    const size = line.match(/^\s+size:\s*(\d+)\s*$/);
    if (size) current.size = Number(size[1]);
  }
  return current?.url?.toLowerCase().endsWith(extension) ? current : null;
}

function releaseTargetMatches({ targetDir, incomingDir, names, manifestName, sourceManifest, version }) {
  const existingNames = fs.readdirSync(targetDir).filter((name) => fs.statSync(path.join(targetDir, name)).isFile()).sort();
  if (JSON.stringify(existingNames) !== JSON.stringify([...names].sort())) return false;
  const expectedManifest = Buffer.from(versionReleaseManifest(sourceManifest, version), 'utf8');
  return names.every((name) => {
    const expected = name === manifestName ? expectedManifest : fs.readFileSync(path.join(incomingDir, name));
    const actual = fs.readFileSync(path.join(targetDir, name));
    return actual.equals(expected);
  });
}
