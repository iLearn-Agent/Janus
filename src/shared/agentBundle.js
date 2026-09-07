import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  isSkillPackageInstalled,
  normalizeSkillPackageId,
  setSkillPackageInstalled,
  skillPackageCatalogRoot,
  skillPackageInstallRoot,
} from './skillPackages.js';

const BUNDLE_SCHEMA_VERSION = 2;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
const INCLUDED_BASENAMES = new Set([
  'department.json',
  'agent.json',
  'lifecycle.json',
  'SKILL.md',
  'DEFAULT_SKILL.md',
]);

export function buildAgentBundle({
  departmentsRoot,
  skillsRoot = '',
  appVersion = '',
  releaseVersion = '',
  sourceMaintenanceRunId = '',
  changeSummary = '',
  createdAt = new Date().toISOString(),
} = {}) {
  if (!departmentsRoot || !fs.existsSync(departmentsRoot)) {
    throw new Error(`Agent bundle departments root does not exist: ${departmentsRoot || '(empty)'}`);
  }
  const files = collectManagedFiles(departmentsRoot);
  if (!files.length) throw new Error('Agent bundle contains no managed organization files.');
  const skillPackages = collectSkillPackages(skillsRoot);
  const contentHash = hashJson(bundleContentDescriptor(files, skillPackages));
  const bundle = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    kind: 'janus_agent_bundle',
    bundleId: `agents-${contentHash.slice(0, 20)}`,
    contentHash,
    createdAt,
    minAppVersion: appVersion || '0.1.0',
    releaseVersion: releaseVersion || appVersion || '0.1.0',
    sourceMaintenanceRunId: String(sourceMaintenanceRunId || ''),
    changeSummary: String(changeSummary || 'Governed Agent, HR, Skill, Memory, and organization update.'),
    fileCount: files.length + skillPackages.reduce((sum, item) => sum + item.files.length, 0),
    organizationFileCount: files.length,
    skillPackageCount: skillPackages.length,
    files,
    skillPackages,
  };
  bundle.sha256 = bundlePayloadHash(bundle);
  return bundle;
}

export function validateAgentBundle(bundle, { expectedSha256 = '' } = {}) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('Agent bundle must be a JSON object.');
  if (Number(bundle.schemaVersion) !== BUNDLE_SCHEMA_VERSION) throw new Error(`Unsupported agent bundle schema: ${bundle.schemaVersion}`);
  if (bundle.kind !== 'janus_agent_bundle') throw new Error('Invalid agent bundle kind.');
  if (!/^agents-[a-f0-9]{20}$/.test(String(bundle.bundleId || ''))) throw new Error('Invalid agent bundle ID.');
  if (!/^\d+\.\d+\.\d+$/.test(String(bundle.releaseVersion || ''))) throw new Error('Invalid Agent release version.');
  if (!Array.isArray(bundle.files) || !bundle.files.length) throw new Error('Agent bundle has no organization files.');
  if (!Array.isArray(bundle.skillPackages)) throw new Error('Agent bundle skillPackages must be an array.');
  let totalBytes = 0;
  const organizationSeen = new Set();
  for (const file of bundle.files) {
    const relativePath = normalizeManagedPath(file?.path);
    if (organizationSeen.has(relativePath)) throw new Error(`Duplicate agent bundle path: ${relativePath}`);
    organizationSeen.add(relativePath);
    totalBytes += validateFileEntry(file, relativePath);
  }
  const packageIds = new Set();
  for (const skillPackage of bundle.skillPackages) {
    const packageId = normalizeSkillPackageId(skillPackage?.id);
    if (packageIds.has(packageId)) throw new Error(`Duplicate skill package: ${packageId}`);
    packageIds.add(packageId);
    if (!Array.isArray(skillPackage.files) || !skillPackage.files.length) throw new Error(`Skill package contains no files: ${packageId}`);
    const fileSeen = new Set();
    for (const file of skillPackage.files) {
      const relativePath = normalizeSkillPath(file?.path);
      if (fileSeen.has(relativePath)) throw new Error(`Duplicate skill package path: ${packageId}/${relativePath}`);
      fileSeen.add(relativePath);
      totalBytes += validateFileEntry(file, `${packageId}/${relativePath}`);
    }
    const packageHash = hashJson(fileDescriptor(skillPackage.files));
    if (packageHash !== skillPackage.contentHash) throw new Error(`Skill package content hash mismatch: ${packageId}`);
  }
  const actualFileCount = bundle.files.length + bundle.skillPackages.reduce((sum, item) => sum + item.files.length, 0);
  if (Number(bundle.fileCount) !== actualFileCount) throw new Error('Agent bundle file count mismatch.');
  if (actualFileCount > 2000) throw new Error('Agent bundle contains too many files.');
  if (totalBytes > MAX_BUNDLE_BYTES) throw new Error('Agent bundle exceeds the maximum uncompressed size.');
  const contentHash = hashJson(bundleContentDescriptor(bundle.files, bundle.skillPackages));
  if (contentHash !== bundle.contentHash) throw new Error('Agent bundle content hash mismatch.');
  if (`agents-${contentHash.slice(0, 20)}` !== bundle.bundleId) throw new Error('Agent bundle ID does not match its content.');
  const payloadHash = bundlePayloadHash(bundle);
  if (payloadHash !== bundle.sha256) throw new Error('Agent bundle payload checksum mismatch.');
  if (expectedSha256 && expectedSha256 !== sha256(`${JSON.stringify(bundle, null, 2)}\n`)) {
    throw new Error('Downloaded agent bundle artifact checksum mismatch.');
  }
  return {
    bundleId: bundle.bundleId,
    contentHash,
    fileCount: bundle.fileCount,
    organizationFileCount: bundle.files.length,
    skillPackageCount: bundle.skillPackages.length,
    totalBytes,
    sha256: payloadHash,
  };
}

export function signAgentBundle(bundle, { privateKeyPem, keyId = '' } = {}) {
  validateAgentBundle(bundle);
  if (!String(privateKeyPem || '').trim()) throw new Error('Agent release signing private key is missing.');
  bundle.signatureAlgorithm = 'ed25519';
  bundle.signingKeyId = keyId || sha256(crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' })).slice(0, 16);
  bundle.signature = crypto.sign(null, Buffer.from(bundle.sha256, 'utf8'), privateKeyPem).toString('base64');
  return bundle;
}

export function verifyAgentBundleSignature(bundle, { publicKeyPem, requiredKeyId = '' } = {}) {
  if (bundle.signatureAlgorithm !== 'ed25519' || !bundle.signature) throw new Error('Agent bundle is not signed.');
  if (!String(publicKeyPem || '').trim()) throw new Error('Agent bundle verification public key is missing.');
  const canonicalPublicKey = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'pem' });
  const actualKeyId = sha256(canonicalPublicKey).slice(0, 16);
  if (requiredKeyId && bundle.signingKeyId !== requiredKeyId) throw new Error('Agent bundle signing key is not trusted.');
  if (bundle.signingKeyId && bundle.signingKeyId !== actualKeyId) throw new Error('Agent bundle signing key ID mismatch.');
  const valid = crypto.verify(
    null,
    Buffer.from(String(bundle.sha256 || ''), 'utf8'),
    publicKeyPem,
    Buffer.from(String(bundle.signature || ''), 'base64'),
  );
  if (!valid) throw new Error('Agent bundle signature verification failed.');
  return { valid: true, signingKeyId: actualKeyId };
}

export function applyAgentBundle({ root, bundle } = {}) {
  validateAgentBundle(bundle);
  const stateRoot = path.join(root, '.janus', 'agent-bundles');
  const departmentsRoot = path.join(root, 'departments');
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(departmentsRoot, { recursive: true });
  const backup = {
    schemaVersion: 2,
    bundleId: bundle.bundleId,
    createdAt: new Date().toISOString(),
    organizationFiles: [],
    skillPackages: [],
  };
  for (const entry of bundle.files) {
    const relativePath = normalizeManagedPath(entry.path);
    const target = path.join(departmentsRoot, relativePath);
    const existed = fs.existsSync(target) && fs.statSync(target).isFile();
    backup.organizationFiles.push({
      path: relativePath,
      existed,
      content: existed ? fs.readFileSync(target, 'utf8') : '',
    });
  }
  for (const skillPackage of bundle.skillPackages) {
    const packageId = normalizeSkillPackageId(skillPackage.id);
    const installed = isSkillPackageInstalled(root, packageId);
    backup.skillPackages.push({
      id: packageId,
      installed,
      catalog: snapshotDirectory(skillPackageCatalogRoot(root, packageId)),
      install: installed ? snapshotDirectory(skillPackageInstallRoot(root, packageId)) : null,
    });
  }
  const backupPath = path.join(stateRoot, `backup-${Date.now()}-${bundle.bundleId}.json`);
  writeJsonAtomic(backupPath, backup);
  try {
    for (const entry of bundle.files) {
      const target = path.join(departmentsRoot, normalizeManagedPath(entry.path));
      writeTextAtomic(target, String(entry.content ?? ''));
    }
    for (const skillPackage of bundle.skillPackages) {
      const packageId = normalizeSkillPackageId(skillPackage.id);
      const catalogRoot = skillPackageCatalogRoot(root, packageId);
      replacePackageDirectory(catalogRoot, skillPackage.files);
      writeJsonAtomic(path.join(catalogRoot, '.package.json'), {
        id: packageId,
        contentHash: skillPackage.contentHash,
        bundleId: bundle.bundleId,
        releaseVersion: bundle.releaseVersion,
        sourceMaintenanceRunId: bundle.sourceMaintenanceRunId || '',
        cachedAt: new Date().toISOString(),
      });
      if (!isSkillPackageInstalled(root, packageId)) continue;
      replacePackageDirectory(skillPackageInstallRoot(root, packageId), skillPackage.files);
      setSkillPackageInstalled(root, packageId, true, {
        source: 'server',
        version: bundle.releaseVersion,
        bundleId: bundle.bundleId,
        contentHash: skillPackage.contentHash,
      });
    }
    const installed = {
      bundleId: bundle.bundleId,
      contentHash: bundle.contentHash,
      sha256: bundle.sha256,
      createdAt: bundle.createdAt,
      appliedAt: new Date().toISOString(),
      minAppVersion: bundle.minAppVersion || '',
      releaseVersion: bundle.releaseVersion || '',
      sourceMaintenanceRunId: bundle.sourceMaintenanceRunId || '',
      changeSummary: bundle.changeSummary || '',
      fileCount: bundle.fileCount,
      skillPackageCount: bundle.skillPackages.length,
      backupPath,
    };
    writeJsonAtomic(path.join(stateRoot, 'current.json'), installed);
    return installed;
  } catch (error) {
    restoreAgentBundleBackup({ root, backupPath });
    throw error;
  }
}

export function rollbackAgentBundle({ root } = {}) {
  const currentPath = path.join(root, '.janus', 'agent-bundles', 'current.json');
  if (!fs.existsSync(currentPath)) throw new Error('No installed agent bundle is available to roll back.');
  const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  const result = restoreAgentBundleBackup({ root, backupPath: current.backupPath });
  writeJsonAtomic(path.join(root, '.janus', 'agent-bundles', 'last-rollback.json'), {
    rolledBackBundleId: current.bundleId || '',
    rolledBackReleaseVersion: current.releaseVersion || '',
    rolledBackAt: new Date().toISOString(),
    backupPath: current.backupPath || '',
  });
  fs.rmSync(currentPath, { force: true });
  return { ...result, rolledBackBundleId: current.bundleId || '', rolledBackReleaseVersion: current.releaseVersion || '' };
}

export function readInstalledAgentBundle(root) {
  const file = path.join(root, '.janus', 'agent-bundles', 'current.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function collectManagedFiles(root) {
  const files = [];
  for (const file of walk(root)) {
    const relativePath = path.relative(root, file).replaceAll(path.sep, '/');
    if (!isManagedOrganizationPath(relativePath)) continue;
    files.push(fileEntry(file, relativePath));
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function collectSkillPackages(skillsRoot) {
  if (!skillsRoot || !fs.existsSync(skillsRoot)) return [];
  const packages = [];
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const id = normalizeSkillPackageId(entry.name);
    const packageRoot = path.join(skillsRoot, entry.name);
    const files = [...walk(packageRoot)]
      .map((file) => fileEntry(file, path.relative(packageRoot, file).replaceAll(path.sep, '/')))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (!files.length) continue;
    packages.push({
      id,
      contentHash: hashJson(fileDescriptor(files)),
      fileCount: files.length,
      files,
    });
  }
  return packages.sort((left, right) => left.id.localeCompare(right.id));
}

function* walk(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === '_unused') continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walk(file);
    else if (entry.isFile()) yield file;
  }
}

function fileEntry(file, relativePath) {
  const content = fs.readFileSync(file, 'utf8');
  const sizeBytes = Buffer.byteLength(content);
  if (sizeBytes > MAX_FILE_BYTES) throw new Error(`Managed bundle file is too large: ${relativePath}`);
  return { path: relativePath, sha256: sha256(content), sizeBytes, content };
}

function validateFileEntry(file, label) {
  const content = String(file?.content ?? '');
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_FILE_BYTES) throw new Error(`Agent bundle file is too large: ${label}`);
  if (sha256(content) !== String(file?.sha256 || '')) throw new Error(`Agent bundle file checksum mismatch: ${label}`);
  if (Number(file?.sizeBytes) !== bytes) throw new Error(`Agent bundle file size mismatch: ${label}`);
  return bytes;
}

function isManagedOrganizationPath(relativePath) {
  const parts = relativePath.split('/');
  if (parts.length === 2 && INCLUDED_BASENAMES.has(parts[1])) return true;
  if (parts.length === 4 && parts[1] === 'agents' && INCLUDED_BASENAMES.has(parts[3])) return true;
  if (parts.length === 3 && parts[1] === 'hr' && INCLUDED_BASENAMES.has(parts[2])) return true;
  if (parts.length === 3 && parts[1] === 'leader' && INCLUDED_BASENAMES.has(parts[2])) return true;
  return false;
}

function normalizeManagedPath(value) {
  const normalized = normalizeRelativePath(value);
  if (!isManagedOrganizationPath(normalized)) throw new Error(`Unmanaged agent bundle path: ${normalized}`);
  return normalized;
}

function normalizeSkillPath(value) {
  return normalizeRelativePath(value);
}

function normalizeRelativePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0') || normalized.split('/').includes('..') || path.isAbsolute(normalized)) {
    throw new Error(`Unsafe bundle path: ${value}`);
  }
  return normalized;
}

function replacePackageDirectory(root, files) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const entry of files) {
    writeTextAtomic(path.join(root, normalizeSkillPath(entry.path)), String(entry.content ?? ''));
  }
}

function snapshotDirectory(root) {
  if (!fs.existsSync(root)) return { existed: false, files: [] };
  const files = [...walkIncludingHidden(root)].map((file) => ({
    path: path.relative(root, file).replaceAll(path.sep, '/'),
    content: fs.readFileSync(file, 'utf8'),
  }));
  return { existed: true, files };
}

function* walkIncludingHidden(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walkIncludingHidden(file);
    else if (entry.isFile()) yield file;
  }
}

function restoreDirectorySnapshot(root, snapshot) {
  fs.rmSync(root, { recursive: true, force: true });
  if (!snapshot?.existed) return;
  fs.mkdirSync(root, { recursive: true });
  for (const entry of snapshot.files || []) {
    writeTextAtomic(path.join(root, normalizeSkillPath(entry.path)), String(entry.content ?? ''));
  }
}

function restoreAgentBundleBackup({ root, backupPath } = {}) {
  if (!backupPath || !fs.existsSync(backupPath)) throw new Error('Agent bundle rollback backup is missing.');
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (Number(backup.schemaVersion) !== 2) throw new Error('Unsupported Agent bundle rollback backup.');
  const departmentsRoot = path.join(root, 'departments');
  for (const entry of backup.organizationFiles || []) {
    const target = path.join(departmentsRoot, normalizeManagedPath(entry.path));
    if (entry.existed) writeTextAtomic(target, String(entry.content ?? ''));
    else fs.rmSync(target, { force: true });
  }
  for (const entry of backup.skillPackages || []) {
    const packageId = normalizeSkillPackageId(entry.id);
    const currentlyInstalled = isSkillPackageInstalled(root, packageId);
    restoreDirectorySnapshot(skillPackageCatalogRoot(root, packageId), entry.catalog);
    if (currentlyInstalled) {
      if (entry.install) {
        restoreDirectorySnapshot(skillPackageInstallRoot(root, packageId), entry.install);
      } else if (entry.catalog?.existed) {
        restoreDirectorySnapshot(skillPackageInstallRoot(root, packageId), {
          existed: true,
          files: (entry.catalog.files || []).filter((item) => item.path !== '.package.json'),
        });
      }
      setSkillPackageInstalled(root, packageId, true, { source: 'rollback', version: '' });
    }
  }
  return {
    status: 'rolled_back',
    restoredFiles: (backup.organizationFiles || []).length,
    restoredSkillPackages: (backup.skillPackages || []).length,
    backupPath,
  };
}

function fileDescriptor(files) {
  return files.map(({ path: relativePath, sha256: fileHash, sizeBytes }) => ({ path: relativePath, sha256: fileHash, sizeBytes }));
}

function bundleContentDescriptor(files, skillPackages) {
  return {
    files: fileDescriptor(files),
    skillPackages: (skillPackages || []).map((item) => ({
      id: item.id,
      contentHash: item.contentHash,
      files: fileDescriptor(item.files || []),
    })),
  };
}

function bundlePayloadHash(bundle) {
  const payload = { ...bundle };
  delete payload.sha256;
  delete payload.signature;
  delete payload.signatureAlgorithm;
  delete payload.signingKeyId;
  return hashJson(payload);
}

function hashJson(value) {
  return sha256(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeJsonAtomic(file, value) {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(file, content) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, file);
}
