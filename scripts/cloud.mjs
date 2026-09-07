#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { cloudHomeFromEnv, createCloudServer, initCloudHome, openCloudDatabase } from '../src/cloud/server.js';
import { normalizeReleaseVersion, releaseArtifactUrl } from '../src/shared/releaseLayout.js';

const command = process.argv[2] || 'help';

if (command === 'init') {
  const result = await initCloudHome();
  console.log(JSON.stringify({ status: 'initialized', ...result }, null, 2));
} else if (command === 'serve') {
  const server = createCloudServer();
  const info = await server.listen();
  console.log(JSON.stringify({ status: 'listening', ...info }, null, 2));
} else if (command === 'promote-stable') {
  const releaseId = process.argv[3] || '';
  const result = promoteStable(releaseId);
  console.log(JSON.stringify(result, null, 2));
} else if (command === 'upload-artifact') {
  const file = process.argv[3] || '';
  const channel = process.argv[4] || process.env.JANUS_RELEASE_CHANNEL || 'dev';
  const result = await uploadArtifact(file, { channel });
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log([
    'Usage:',
    '  node scripts/cloud.mjs init',
    '  node scripts/cloud.mjs serve',
    '  node scripts/cloud.mjs promote-stable <release-id>',
    '  node scripts/cloud.mjs upload-artifact <file> [channel]',
  ].join('\n'));
}


function promoteStable(releaseId) {
  const home = operationalCloudHome();
  const db = openCloudDatabase(home);
  const row = releaseId
    ? db.prepare('SELECT * FROM release_manifests WHERE id = ?').get(releaseId)
    : db.prepare("SELECT * FROM release_manifests WHERE channel = 'dev' ORDER BY created_at DESC LIMIT 1").get();
  if (!row) throw new Error('No dev release found to promote.');
  const manifest = JSON.parse(row.manifest_json || '{}');
  const stableManifest = { ...manifest, id: `stable-${manifest.id || row.id}`, channel: 'stable', promotedFrom: row.id, promotedAt: new Date().toISOString() };
  insertReleaseManifest(home, stableManifest);
  db.close();
  return { status: 'promoted', releaseId: stableManifest.id, promotedFrom: row.id };
}

async function uploadArtifact(file, { channel = 'dev' } = {}) {
  if (!file) throw new Error('artifact file is required');
  const home = operationalCloudHome();
  await initCloudHome({ home });
  const source = path.resolve(file);
  const name = path.basename(source);
  const version = normalizeReleaseVersion(process.env.JANUS_RELEASE_VERSION || 'manual');
  const platform = releaseArtifactPlatform(name);
  const arch = platform === 'darwin' ? 'arm64' : 'x64';
  const platformDirName = releasePlatformDirectory(platform);
  const relativeName = path.posix.join(platformDirName, version, name);
  const target = path.join(home, 'releases', platformDirName, version, name);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(source, target);
  const artifact = await artifactManifest(target, { url: releaseArtifactUrl(relativeName), platform, arch });
  const manifest = {
    id: `${channel}-manual-${Date.now()}`,
    channel,
    version: '',
    commit: gitCommit(),
    createdAt: new Date().toISOString(),
    platform,
    arch,
    artifacts: [artifact],
  };
  insertReleaseManifest(home, manifest);
  return { status: 'uploaded', artifact, manifestId: manifest.id };
}


function releaseArtifactPlatform(name = '') {
  if (/^latest-mac\.yml$|\.(?:dmg|zip)(?:\.blockmap)?$/i.test(name)) return 'darwin';
  if (/^latest\.yml$|\.exe(?:\.blockmap)?$/i.test(name)) return 'win32';
  if (/^latest-linux\.yml$|\.AppImage(?:\.blockmap)?$/i.test(name)) return 'linux';
  throw new Error(`Unsupported desktop release artifact: ${name}`);
}

function releasePlatformDirectory(platform = '') {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return '';
}


async function artifactManifest(file, overrides = {}) {
  const buffer = await fsp.readFile(file);
  return {
    name: path.basename(file),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    sizeBytes: buffer.length,
    platform: 'any',
    arch: 'any',
    url: `/v1/releases/artifacts/${encodeURIComponent(path.basename(file))}`,
    ...overrides,
  };
}

function insertReleaseManifest(home, manifest) {
  const db = openCloudDatabase(home);
  db.prepare(
    `INSERT OR REPLACE INTO release_manifests (
      id, channel, version, platform, arch, manifest_json, promoted_from
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    manifest.id,
    manifest.channel,
    manifest.version || '',
    manifest.platform || 'any',
    manifest.arch || 'any',
    JSON.stringify(manifest),
    manifest.promotedFrom || '',
  );
  db.close();
}

function gitCommit() {
  const result = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : '';
}


function operationalCloudHome() {
  if (process.env.JANUS_CLOUD_HOME) return process.env.JANUS_CLOUD_HOME;
  if (fs.existsSync('/path/to/janus-cloud')) return '/path/to/janus-cloud';
  return cloudHomeFromEnv();
}
