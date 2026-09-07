#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { insertReleaseManifest } from '../src/cloud/releasePublisher.js';
import { normalizeReleaseVersion, releaseArtifactUrl, versionReleaseManifest } from '../src/shared/releaseLayout.js';
import { checksumsEqual, readMacUpdateSignatureManifest, sha512File, verifyUpdateMetadata } from '../src/shared/updateSignature.js';
import { prunePlatformReleaseDirectories } from '../src/shared/releaseRetention.js';
import { promoteUnifiedDesktopFeeds } from '../src/shared/unifiedDesktopRelease.js';

const cloudHome = process.env.JANUS_CLOUD_HOME || '/path/to/janus-cloud';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = normalizeReleaseVersion(argumentValue('--version'));
const incomingDir = path.resolve(argumentValue('--incoming'));
const incomingRoot = path.resolve(cloudHome, 'incoming');
const releasesDirectory = releaseDirectory(argumentValue('--releases-dir', 'releases'));

if (!incomingDir.startsWith(`${incomingRoot}${path.sep}`)) {
  throw new Error(`macOS release input must be under ${incomingRoot}`);
}
if (!fs.existsSync(incomingDir)) throw new Error(`macOS release input does not exist: ${incomingDir}`);

const names = fs.readdirSync(incomingDir).filter((name) => fs.statSync(path.join(incomingDir, name)).isFile());
const dmgNames = names.filter((name) => name.endsWith('.dmg'));
if (dmgNames.length !== 1) throw new Error(`Expected exactly one macOS DMG, found ${dmgNames.length}.`);
const zipNames = names.filter((name) => name.endsWith('.zip'));
if (zipNames.length !== 1) throw new Error(`Expected exactly one macOS update ZIP, found ${zipNames.length}.`);
if (!names.includes('latest-mac.yml')) throw new Error('latest-mac.yml is missing from the macOS release input.');
const allowedNames = new Set([
  dmgNames[0],
  `${dmgNames[0]}.blockmap`,
  zipNames[0],
  `${zipNames[0]}.blockmap`,
  'latest-mac.yml',
]);
const unexpectedNames = names.filter((name) => !allowedNames.has(name));
if (unexpectedNames.length) throw new Error(`Unexpected macOS release files: ${unexpectedNames.join(', ')}`);

const sourceManifest = await fsp.readFile(path.join(incomingDir, 'latest-mac.yml'), 'utf8');
const signedUpdate = readMacUpdateSignatureManifest(sourceManifest);
if (!['custom-macos', 'standard'].includes(signedUpdate.installMode)) throw new Error('latest-mac.yml has an invalid Janus install mode.');
const zipPath = path.join(incomingDir, zipNames[0]);
const zipStat = await fsp.stat(zipPath);
const zipSha512 = await sha512File(zipPath);
const manifestZip = manifestFileEntry(sourceManifest, '.zip');
if (
  !manifestZip
  || path.posix.basename(manifestZip.url) !== zipNames[0]
  || Number(manifestZip.size) !== zipStat.size
  || !checksumsEqual(manifestZip.sha512, zipSha512)
) {
  throw new Error('latest-mac.yml ZIP entry does not match the uploaded ZIP.');
}
if (
  signedUpdate.metadata.version !== version
  || signedUpdate.metadata.file !== zipNames[0]
  || signedUpdate.metadata.size !== zipStat.size
  || !checksumsEqual(signedUpdate.metadata.sha512, zipSha512)
) {
  throw new Error('Signed macOS update metadata does not match the uploaded ZIP.');
}
const signingPublicKeyPath = process.env.JANUS_RELEASE_SIGNING_PUBLIC_KEY || path.join(projectRoot, 'assets', 'release-signing-public.pem');
verifyUpdateMetadata(signedUpdate.metadata, await fsp.readFile(signingPublicKeyPath, 'utf8'));

const releasesRoot = path.join(cloudHome, releasesDirectory, 'macos');
const targetDir = path.join(releasesRoot, version);
if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length) {
  throw new Error(`macOS release ${version} already exists and is immutable.`);
}

const stagingDir = path.join(releasesRoot, `.${version}.${process.pid}.tmp`);
await fsp.rm(stagingDir, { recursive: true, force: true });
await fsp.mkdir(stagingDir, { recursive: true });
try {
  for (const name of names) {
    const source = path.join(incomingDir, name);
    const target = path.join(stagingDir, name);
    if (name === 'latest-mac.yml') {
      const manifest = await fsp.readFile(source, 'utf8');
      await fsp.writeFile(target, versionReleaseManifest(manifest, version), 'utf8');
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

const artifacts = names.map((name) => artifactManifest(path.join(targetDir, name), {
  kind: name.endsWith('.dmg') ? 'application_installer' : name.endsWith('.zip') ? 'application_update' : name === 'latest-mac.yml' ? 'update_feed' : 'blockmap',
  url: releaseArtifactUrl(`macos/${version}/${name}`),
}));
const createdAt = new Date().toISOString();
const devManifest = {
  id: `dev-macos-${version}-${Date.now()}`,
  releaseType: 'application',
  channel: 'dev',
  version,
  createdAt,
  platform: 'darwin',
  arch: 'arm64',
  artifacts,
};
if (releasesDirectory === 'releases') {
  insertReleaseManifest(cloudHome, devManifest);
  insertReleaseManifest(cloudHome, {
    ...devManifest,
    id: `stable-macos-${version}-${Date.now()}`,
    channel: 'stable',
    promotedFrom: devManifest.id,
    promotedAt: new Date().toISOString(),
  });
}

const promotion = await promoteUnifiedDesktopFeeds(cloudHome, version, { releasesDirectory });
const retentionLimit = releasesDirectory === 'test_releases' ? 1 : 3;
const retention = await prunePlatformReleaseDirectories(releasesRoot, { keep: retentionLimit });
await fsp.rm(incomingDir, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ status: 'published', version, platform: 'darwin', arch: 'arm64', targetDir, promotion, retention }, null, 2)}\n`);

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

function artifactManifest(file, overrides = {}) {
  const buffer = fs.readFileSync(file);
  return {
    name: path.basename(file),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    sha512: crypto.createHash('sha512').update(buffer).digest('base64'),
    sizeBytes: buffer.length,
    platform: 'darwin',
    arch: 'arm64',
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
