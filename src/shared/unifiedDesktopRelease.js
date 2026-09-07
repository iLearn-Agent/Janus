import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { normalizeReleaseVersion } from './releaseLayout.js';

const PLATFORM_FEEDS = [
  { platform: 'windows', feed: 'latest.yml' },
  { platform: 'macos', feed: 'latest-mac.yml' },
  { platform: 'linux', feed: 'latest-linux.yml' },
];

export function unifiedDesktopReleaseReadiness(cloudHome, versionValue = '', { releasesDirectory = 'releases' } = {}) {
  const version = normalizeReleaseVersion(versionValue);
  const available = PLATFORM_FEEDS
    .filter(({ platform, feed }) => fs.existsSync(path.join(cloudHome, releasesDirectory, platform, version, feed)))
    .map(({ platform }) => platform);
  const missing = PLATFORM_FEEDS
    .filter(({ platform }) => !available.includes(platform))
    .map(({ platform }) => platform);
  return { ready: missing.length === 0, version, available, missing };
}

export async function promoteUnifiedDesktopFeeds(cloudHome, versionValue = '', { releasesDirectory = 'releases' } = {}) {
  const readiness = unifiedDesktopReleaseReadiness(cloudHome, versionValue, { releasesDirectory });
  const promoted = [];
  for (const { platform } of PLATFORM_FEEDS.filter((item) => readiness.available.includes(item.platform))) {
    await promoteDesktopPlatformFeed(cloudHome, platform, readiness.version, { releasesDirectory });
    promoted.push(platform);
  }
  return {
    status: readiness.ready ? 'promoted' : promoted.length ? 'partially_promoted' : 'awaiting_platforms',
    ...readiness,
    promoted,
  };
}

export async function promoteDesktopPlatformFeed(cloudHome, platformValue = '', versionValue = '', { releasesDirectory = 'releases' } = {}) {
  const platformEntry = PLATFORM_FEEDS.find(({ platform }) => platform === platformValue);
  if (!platformEntry) throw new Error(`Unsupported desktop release platform: ${platformValue}`);
  const version = normalizeReleaseVersion(versionValue);
  const releasesRoot = path.join(cloudHome, releasesDirectory);
  const manifestPath = path.join(releasesRoot, platformEntry.platform, version, platformEntry.feed);
  if (!fs.existsSync(manifestPath)) throw new Error(`Desktop release feed does not exist: ${manifestPath}`);
  await pointPlatformFeed(path.join(releasesRoot, platformEntry.platform), platformEntry.feed, version);
  const manifest = await fsp.readFile(manifestPath, 'utf8');
  await writeLegacyFeed(releasesRoot, platformEntry.feed, manifest, platformEntry.platform);
  return { status: 'promoted', platform: platformEntry.platform, version };
}

async function pointPlatformFeed(platformRoot, feed, version) {
  const link = path.join(platformRoot, feed);
  const temporary = path.join(platformRoot, `.${feed}.${process.pid}.tmp`);
  await fsp.rm(temporary, { force: true });
  await fsp.symlink(`${version}/${feed}`, temporary);
  await fsp.rename(temporary, link);
}

async function writeLegacyFeed(releasesRoot, feed, manifest, platform) {
  const target = path.join(releasesRoot, feed);
  const temporary = path.join(releasesRoot, `.${feed}.${process.pid}.tmp`);
  const legacyManifest = String(manifest || '')
    .split(/(?<=\n)/)
    .map((line) => prefixManifestArtifact(line, platform))
    .join('');
  await fsp.writeFile(temporary, legacyManifest, 'utf8');
  await fsp.rename(temporary, target);
}

function prefixManifestArtifact(line, platform) {
  const match = line.match(/^(\s*(?:-\s*)?(?:url|path):\s*)(.*?)(\r?\n)?$/);
  if (!match) return line;
  const rawValue = match[2].trim();
  const newline = match[3] || '';
  const quote = (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ? "'"
    : (rawValue.startsWith('"') && rawValue.endsWith('"'))
      ? '"'
      : '';
  const value = quote ? rawValue.slice(1, -1) : rawValue;
  if (!value || value.startsWith(`${platform}/`) || value.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return line;
  }
  return `${match[1]}${quote}${platform}/${value}${quote}${newline}`;
}
