import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export async function prunePlatformReleaseDirectories(releasesRoot, { keep = 3 } = {}) {
  const limit = Math.max(1, Number(keep) || 3);
  if (!fs.existsSync(releasesRoot)) return { retained: [], removed: [] };
  const versions = fs.readdirSync(releasesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+(?:[-._][0-9A-Za-z.-]+)?$/.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareReleaseVersionsDescending);
  const retained = versions.slice(0, limit);
  const removed = versions.slice(limit);
  for (const version of removed) {
    await fsp.rm(path.join(releasesRoot, version), { recursive: true, force: true });
  }
  return { retained, removed };
}

function compareReleaseVersionsDescending(left, right) {
  const a = releaseVersionParts(left);
  const b = releaseVersionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return b.core[index] - a.core[index];
  }
  if (!a.prerelease && b.prerelease) return -1;
  if (a.prerelease && !b.prerelease) return 1;
  return b.prerelease.localeCompare(a.prerelease, undefined, { numeric: true, sensitivity: 'base' });
}

function releaseVersionParts(value = '') {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  return {
    core: match ? match.slice(1, 4).map(Number) : [0, 0, 0],
    prerelease: match?.[4]?.replace(/^[-._]+/, '') || '',
  };
}
