import path from 'node:path';

export function normalizeReleaseVersion(value = '') {
  const version = String(value || '').trim().replace(/^v(?=\d)/i, '');
  if (!version || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version) || version === '.' || version === '..') {
    throw new Error(`Invalid release version: ${value}`);
  }
  return version;
}

export function normalizeReleaseArtifactPath(value = '') {
  const relativePath = String(value || '').trim().replace(/\\/g, '/');
  const parts = relativePath.split('/');
  if (
    !relativePath
    || relativePath.startsWith('/')
    || relativePath.includes('\0')
    || parts.some((part) => !part || part === '.' || part === '..')
  ) {
    return '';
  }
  return parts.join('/');
}

export function releaseArtifactFile(releasesDir, relativePath = '') {
  const safePath = normalizeReleaseArtifactPath(relativePath);
  return safePath ? path.join(releasesDir, ...safePath.split('/')) : '';
}

export function releaseArtifactUrl(relativePath = '') {
  const safePath = normalizeReleaseArtifactPath(relativePath);
  if (!safePath) throw new Error(`Invalid release artifact path: ${relativePath}`);
  return `/v1/releases/artifacts/${encodeURIComponent(safePath)}`;
}

export function versionReleaseManifest(text = '', versionValue = '') {
  const version = normalizeReleaseVersion(versionValue);
  return String(text || '')
    .split(/(?<=\n)/)
    .map((line) => versionManifestLine(line, version))
    .join('');
}

function versionManifestLine(line, version) {
  const match = line.match(/^(\s*(?:-\s*)?(?:url|path):\s*)(.*?)(\r?\n)?$/);
  if (!match) return line;
  const prefix = match[1];
  const newline = match[3] || '';
  const rawValue = match[2].trim();
  if (!rawValue) return line;
  const quote = (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ? "'"
    : (rawValue.startsWith('"') && rawValue.endsWith('"'))
      ? '"'
      : '';
  const value = quote ? rawValue.slice(1, -1) : rawValue;
  if (!value || value.startsWith(`${version}/`) || value.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return line;
  }
  return `${prefix}${quote}${version}/${value}${quote}${newline}`;
}
