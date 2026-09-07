import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { buildAgentBundle, signAgentBundle, validateAgentBundle } from '../shared/agentBundle.js';
import { normalizeReleaseVersion, releaseArtifactUrl } from '../shared/releaseLayout.js';
import { prunePlatformReleaseDirectories } from '../shared/releaseRetention.js';
import { unifiedDesktopReleaseReadiness } from '../shared/unifiedDesktopRelease.js';
import { openCloudDatabase } from './server.js';

export { unifiedDesktopReleaseReadiness } from '../shared/unifiedDesktopRelease.js';

export async function publishAgentBundleRelease({
  cloudHome,
  departmentsRoot,
  skillsRoot = '',
  appVersion = '',
  sourceMaintenanceRunId = '',
  changeSummary = '',
  channel = 'dev',
  promoteStable = false,
} = {}) {
  const releaseVersion = unifiedAgentReleaseVersion(appVersion);
  const desktopRelease = unifiedDesktopReleaseReadiness(cloudHome, releaseVersion);
  if (!desktopRelease.available.length) {
    throw new Error(`Agent Bundle ${releaseVersion} requires at least one matching desktop release.`);
  }
  const bundle = buildAgentBundle({ departmentsRoot, skillsRoot, appVersion, releaseVersion, sourceMaintenanceRunId, changeSummary });
  validateAgentBundle(bundle);
  const signingKeyPath = process.env.JANUS_RELEASE_SIGNING_KEY || path.join(cloudHome, 'release-signing-private.pem');
  if (!fs.existsSync(signingKeyPath)) throw new Error(`Agent release signing key not found: ${signingKeyPath}`);
  signAgentBundle(bundle, { privateKeyPem: fs.readFileSync(signingKeyPath, 'utf8') });
  const existing = latestBundleByContentHash(cloudHome, bundle.contentHash, channel, bundle.signingKeyId, releaseVersion);
  if (existing) {
    return { status: 'unchanged', bundle, manifest: existing, promoted: false };
  }
  const releasesDir = path.join(cloudHome, 'releases', 'agents');
  const version = normalizeReleaseVersion(bundle.releaseVersion);
  const versionDir = path.join(releasesDir, version);
  await fsp.mkdir(versionDir, { recursive: true });
  const filename = `janus-${bundle.bundleId}.json`;
  const bundlePath = path.join(versionDir, filename);
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  await fsp.writeFile(bundlePath, serialized, 'utf8');
  const artifact = artifactManifest(bundlePath, {
    url: releaseArtifactUrl(`agents/${version}/${filename}`),
    kind: 'agent_bundle',
    platform: 'any',
    arch: 'any',
    bundleId: bundle.bundleId,
    releaseVersion: bundle.releaseVersion,
    contentHash: bundle.contentHash,
    minAppVersion: bundle.minAppVersion,
    signingKeyId: bundle.signingKeyId,
  });
  const manifest = {
    id: `${channel}-${bundle.bundleId}-${Date.now()}`,
    releaseType: 'agent_bundle',
    channel,
    version,
    createdAt: new Date().toISOString(),
    platform: 'any',
    arch: 'any',
    sourceMaintenanceRunId,
    changeSummary: bundle.changeSummary,
    artifacts: [artifact],
  };
  insertReleaseManifest(cloudHome, manifest);
  let stableManifest = null;
  if (promoteStable && channel !== 'stable') {
    stableManifest = {
      ...manifest,
      id: `stable-${bundle.bundleId}-${Date.now()}`,
      channel: 'stable',
      promotedFrom: manifest.id,
      promotedAt: new Date().toISOString(),
    };
    insertReleaseManifest(cloudHome, stableManifest);
  }
  const retention = await prunePlatformReleaseDirectories(releasesDir, { keep: 3 });
  return { status: 'published', bundle, manifest, stableManifest, promoted: Boolean(stableManifest), retention };
}

export function insertReleaseManifest(cloudHome, manifest) {
  const db = openCloudDatabase(cloudHome);
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

export function latestBundleByContentHash(cloudHome, contentHash, channel = '', signingKeyId = '', releaseVersion = '') {
  const db = openCloudDatabase(cloudHome);
  const rows = channel
    ? db.prepare('SELECT manifest_json FROM release_manifests WHERE channel = ? ORDER BY created_at DESC LIMIT 50').all(channel)
    : db.prepare('SELECT manifest_json FROM release_manifests ORDER BY created_at DESC LIMIT 100').all();
  db.close();
  for (const row of rows) {
    const manifest = safeJson(row.manifest_json);
    const artifact = (manifest.artifacts || []).find((item) => item.kind === 'agent_bundle');
    if (!artifact) continue;
    return artifact.contentHash === contentHash
      && (!signingKeyId || artifact.signingKeyId === signingKeyId)
      && (!releaseVersion || artifact.releaseVersion === releaseVersion)
      ? manifest
      : null;
  }
  return null;
}

export function unifiedAgentReleaseVersion(appVersion = '') {
  return normalizeReleaseVersion(appVersion);
}

export function artifactManifest(file, overrides = {}) {
  const buffer = fs.readFileSync(file);
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

function safeJson(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}
