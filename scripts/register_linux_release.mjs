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

const cloudHome = process.env.JANUS_CLOUD_HOME || '/path/to/janus-cloud';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = normalizeReleaseVersion(argumentValue('--version'));
const incomingDir = path.resolve(argumentValue('--incoming'));
const incomingRoot = path.resolve(cloudHome, 'incoming');
const releasesDirectory = releaseDirectory(argumentValue('--releases-dir', 'releases'));

if (!incomingDir.startsWith(`${incomingRoot}${path.sep}`)) {
  throw new Error(`Linux release input must be under ${incomingRoot}`);
}
if (!fs.existsSync(incomingDir)) throw new Error(`Linux release input does not exist: ${incomingDir}`);

const names = fs.readdirSync(incomingDir).filter((name) => fs.statSync(path.join(incomingDir, name)).isFile());
const appImageNames = names.filter((name) => name.endsWith('.AppImage'));
if (appImageNames.length !== 1) throw new Error(`Expected exactly one Linux AppImage, found ${appImageNames.length}.`);
if (!names.includes('latest-linux.yml')) throw new Error('latest-linux.yml is missing from the Linux release input.');
const optionalBlockmap = `${appImageNames[0]}.blockmap`;
const allowedNames = new Set([appImageNames[0], optionalBlockmap, 'latest-linux.yml']);
const unexpectedNames = names.filter((name) => !allowedNames.has(name));
if (unexpectedNames.length) throw new Error(`Unexpected Linux release files: ${unexpectedNames.join(', ')}`);

const sourceManifest = await fsp.readFile(path.join(incomingDir, 'latest-linux.yml'), 'utf8');
const manifestVersion = sourceManifest.match(/^version:\s*['"]?([^'"\r\n]+)['"]?\s*$/m)?.[1]?.trim() || '';
if (manifestVersion !== version) throw new Error(`latest-linux.yml version ${manifestVersion || '(missing)'} does not match ${version}.`);
const appImagePath = path.join(incomingDir, appImageNames[0]);
const appImageBuffer = await fsp.readFile(appImagePath);
const manifestAppImage = manifestFileEntry(sourceManifest, '.AppImage');
const appImageSha512 = crypto.createHash('sha512').update(appImageBuffer).digest('base64');
if (
  !manifestAppImage
  || path.posix.basename(manifestAppImage.url) !== appImageNames[0]
  || Number(manifestAppImage.size) !== appImageBuffer.length
  || !checksumsEqual(manifestAppImage.sha512, appImageSha512)
) {
  throw new Error('latest-linux.yml AppImage entry does not match the uploaded AppImage.');
}
const signedUpdate = readUpdateSignatureManifest(sourceManifest);
if (
  signedUpdate.metadata.version !== version
  || signedUpdate.metadata.file !== appImageNames[0]
  || signedUpdate.metadata.size !== appImageBuffer.length
  || !checksumsEqual(signedUpdate.metadata.sha512, appImageSha512)
) {
  throw new Error('Signed Linux update metadata does not match the uploaded AppImage.');
}
const signingPublicKeyPath = process.env.JANUS_RELEASE_SIGNING_PUBLIC_KEY || path.join(projectRoot, 'assets', 'release-signing-public.pem');
verifyUpdateMetadata(signedUpdate.metadata, await fsp.readFile(signingPublicKeyPath, 'utf8'));

const releasesRoot = path.join(cloudHome, releasesDirectory, 'linux');
const targetDir = path.join(releasesRoot, version);
const targetExists = fs.existsSync(targetDir) && fs.readdirSync(targetDir).length;
const reuseTarget = targetExists && releaseTargetMatches({
  targetDir, incomingDir, names, manifestName: 'latest-linux.yml', sourceManifest, version,
});
if (targetExists && !reuseTarget) throw new Error(`Linux release ${version} already exists and is immutable.`);

const stagingDir = path.join(releasesRoot, `.${version}.${process.pid}.tmp`);
if (!reuseTarget) {
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await fsp.mkdir(stagingDir, { recursive: true });
  try {
    for (const name of names) {
      const source = path.join(incomingDir, name);
      const target = path.join(stagingDir, name);
      if (name === 'latest-linux.yml') {
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
  kind: name.endsWith('.AppImage')
    ? 'application_update'
    : name === 'latest-linux.yml'
      ? 'update_feed'
      : 'blockmap',
  url: releaseArtifactUrl(`linux/${version}/${name}`),
}));
const createdAt = new Date().toISOString();
const devManifest = {
  id: `dev-linux-${version}-${Date.now()}`,
  releaseType: 'application',
  channel: 'dev',
  version,
  createdAt,
  platform: 'linux',
  arch: 'x64',
  artifacts,
};
if (releasesDirectory === 'releases') {
  insertReleaseManifest(cloudHome, devManifest);
  insertReleaseManifest(cloudHome, {
    ...devManifest,
    id: `stable-linux-${version}-${Date.now()}`,
    channel: 'stable',
    promotedFrom: devManifest.id,
    promotedAt: new Date().toISOString(),
  });
}

const promotion = await promoteUnifiedDesktopFeeds(cloudHome, version, { releasesDirectory });
const retentionLimit = releasesDirectory === 'test_releases' ? 1 : 3;
const retention = await prunePlatformReleaseDirectories(releasesRoot, { keep: retentionLimit });
await fsp.rm(incomingDir, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ status: 'published', version, platform: 'linux', arch: 'x64', targetDir, promotion, retention }, null, 2)}\n`);

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
    platform: 'linux',
    arch: 'x64',
    ...overrides,
  };
}

function manifestFileEntry(text, extension) {
  const normalizedExtension = extension.toLowerCase();
  const lines = String(text || '').split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const url = line.match(/^\s*-\s+url:\s*['"]?(.+?)['"]?\s*$/);
    if (url) {
      if (current?.url?.toLowerCase().endsWith(normalizedExtension)) return current;
      current = { url: url[1] };
      continue;
    }
    if (!current) continue;
    const sha = line.match(/^\s+sha512:\s*['"]?([^'"\s]+)['"]?\s*$/);
    if (sha) current.sha512 = sha[1];
    const size = line.match(/^\s+size:\s*(\d+)\s*$/);
    if (size) current.size = Number(size[1]);
  }
  return current?.url?.toLowerCase().endsWith(normalizedExtension) ? current : null;
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
