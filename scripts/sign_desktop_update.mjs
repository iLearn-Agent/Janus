#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { checksumsEqual, sha512File, signUpdateMetadata } from '../src/shared/updateSignature.js';
import { releaseAnnouncementForVersion } from '../src/shared/releaseAnnouncements.js';

const distDir = path.resolve(argumentValue('--dist', 'dist'));
const privateKeyPath = path.resolve(argumentValue('--private-key'));
const platform = argumentValue('--platform');
const platformConfig = platform === 'macos'
  ? { manifestName: 'latest-mac.yml', extension: '.zip', installMode: argumentValue('--install-mode', 'custom-macos') }
  : platform === 'windows'
    ? { manifestName: 'latest.yml', extension: '.exe', installMode: '' }
    : platform === 'linux'
      ? { manifestName: 'latest-linux.yml', extension: '.AppImage', installMode: '' }
    : null;
if (!platformConfig) throw new Error(`Unsupported desktop update platform: ${platform}`);
if (platform === 'macos' && !['custom-macos', 'standard'].includes(platformConfig.installMode)) {
  throw new Error(`Unsupported macOS install mode: ${platformConfig.installMode}`);
}

const manifestPath = path.join(distDir, platformConfig.manifestName);
if (!fs.existsSync(manifestPath)) throw new Error(`${platformConfig.manifestName} is missing from ${distDir}`);
const artifactExtension = platformConfig.extension.toLowerCase();
const artifactNames = fs.readdirSync(distDir).filter((name) => name.toLowerCase().endsWith(artifactExtension));
if (artifactNames.length !== 1) {
  throw new Error(`Expected exactly one ${platform} update package, found ${artifactNames.length}.`);
}
const artifactName = artifactNames[0];
const artifactPath = path.join(distDir, artifactName);
const manifest = await fsp.readFile(manifestPath, 'utf8');
const version = manifest.match(/^version:\s*['"]?([^'"\r\n]+)['"]?\s*$/m)?.[1]?.trim() || '';
if (!version) throw new Error(`${platformConfig.manifestName} does not contain a version.`);
const manifestArtifact = manifestFileEntry(manifest, artifactExtension);
if (!manifestArtifact || path.posix.basename(manifestArtifact.url) !== artifactName) {
  throw new Error(`${platformConfig.manifestName} does not reference the generated package ${artifactName}.`);
}
const sha512 = await sha512File(artifactPath);
const size = (await fsp.stat(artifactPath)).size;
if (!checksumsEqual(manifestArtifact.sha512, sha512) || Number(manifestArtifact.size) !== size) {
  throw new Error(`${platformConfig.manifestName} checksum or size does not match the generated package.`);
}
const privateKeyPem = await fsp.readFile(privateKeyPath, 'utf8');
const metadata = signUpdateMetadata({ version, file: artifactName, sha512, size }, privateKeyPem);
const announcement = releaseAnnouncementForVersion(version);
const unsignedManifest = stripJanusSignature(manifest).trimEnd();
const releaseNotes = /^releaseNotes:/m.test(unsignedManifest) ? '' : serializeReleaseAnnouncement(announcement);
const signedManifest = `${unsignedManifest}\n${releaseNotes}${serializeSignature(platformConfig.installMode, metadata)}`;
await fsp.writeFile(manifestPath, signedManifest, 'utf8');
process.stdout.write(`${JSON.stringify({ platform, version, file: artifactName, size, installMode: platformConfig.installMode, keyId: metadata.keyId }, null, 2)}\n`);

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
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

function stripJanusSignature(text) {
  return String(text || '').replace(/\n(?:janusInstallMode:[^\n]*\n)?janusUpdateSignature:\n(?:  .*\n?)*/m, '\n');
}

function serializeSignature(installMode, metadata) {
  return [
    ...(installMode ? [`janusInstallMode: ${yamlScalar(installMode)}`] : []),
    'janusUpdateSignature:',
    `  schemaVersion: ${metadata.schemaVersion}`,
    `  algorithm: ${yamlScalar(metadata.algorithm)}`,
    `  keyId: ${yamlScalar(metadata.keyId)}`,
    `  version: ${yamlScalar(metadata.version)}`,
    `  file: ${yamlScalar(metadata.file)}`,
    `  sha512: ${yamlScalar(metadata.sha512)}`,
    `  size: ${metadata.size}`,
    `  signature: ${yamlScalar(metadata.signature)}`,
    '',
  ].join('\n');
}

function serializeReleaseAnnouncement(announcement) {
  if (!announcement) return '';
  const lines = [announcement.summary, ...(announcement.highlights || []).map((item) => `- ${item}`)]
    .map((item) => String(item || '').replace(/[\r\n]+/g, ' ').trim())
    .filter(Boolean);
  if (!lines.length) return '';
  return [
    `releaseName: ${yamlScalar(announcement.title || `Janus ${announcement.version}`)}`,
    'releaseNotes: |-',
    ...lines.map((line) => `  ${line}`),
    '',
  ].join('\n');
}

function yamlScalar(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
