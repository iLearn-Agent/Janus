import fs from 'node:fs';
import path from 'node:path';

export function normalizeSkillPackageId(value) {
  const id = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id)) throw new Error(`Invalid skill package ID: ${value || '(empty)'}`);
  return id;
}

export function skillPackageInstallRoot(root, packageId) {
  return path.join(root, 'skills', normalizeSkillPackageId(packageId));
}

export function skillPackageCatalogRoot(root, packageId) {
  return path.join(root, '.janus', 'skill-catalog', normalizeSkillPackageId(packageId));
}

export function skillPackageStatePath(root) {
  return path.join(root, '.janus', 'skills', 'state.json');
}

export function readSkillPackageState(root) {
  const file = skillPackageStatePath(root);
  if (!fs.existsSync(file)) return { schemaVersion: 1, packages: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      schemaVersion: 1,
      packages: parsed?.packages && typeof parsed.packages === 'object' && !Array.isArray(parsed.packages)
        ? parsed.packages
        : {},
    };
  } catch {
    return { schemaVersion: 1, packages: {} };
  }
}

export function skillPackageState(root, packageId) {
  const id = normalizeSkillPackageId(packageId);
  return readSkillPackageState(root).packages[id] || { installed: false };
}

export function isSkillPackageInstalled(root, packageId) {
  return skillPackageState(root, packageId).installed === true;
}

export function setSkillPackageInstalled(root, packageId, installed, metadata = {}) {
  const id = normalizeSkillPackageId(packageId);
  const state = readSkillPackageState(root);
  const now = new Date().toISOString();
  state.packages[id] = {
    ...(state.packages[id] || {}),
    ...metadata,
    installed: Boolean(installed),
    updatedAt: now,
    ...(installed ? { installedAt: state.packages[id]?.installedAt || now, uninstalledAt: '' } : { uninstalledAt: now }),
  };
  writeJsonAtomic(skillPackageStatePath(root), state);
  return state.packages[id];
}

export function readCachedSkillPackage(root, packageId) {
  const id = normalizeSkillPackageId(packageId);
  const packageRoot = skillPackageCatalogRoot(root, id);
  const manifestPath = path.join(packageRoot, '.package.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest?.id !== id) return null;
    return { ...manifest, root: packageRoot, manifestPath };
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}
