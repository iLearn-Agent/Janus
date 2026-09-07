import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { FOLLOWER_RELEASE_BASELINE_VERSION } from './cloudContracts.js';

export const FOLLOWER_SYSTEM_BUNDLE_KIND = 'system-agent-bundle-v1';
const ALLOWED_FILES = new Set(['agent.json', 'lifecycle.json', 'SKILL.md', 'MEMORY.md', 'references/report-contract.md']);
const MAX_FILE_BYTES = 256 * 1024;
const MAX_BUNDLE_BYTES = 1024 * 1024;

export function buildFollowerSystemAgentBundle({ files = [], releaseVersion = FOLLOWER_RELEASE_BASELINE_VERSION,
  minAppVersion = FOLLOWER_RELEASE_BASELINE_VERSION, reportContractVersion = 'follower_report_v2',
  privacyValidatorVersion = 'follower_privacy_v1', sourceCandidateId = '', createdAt = new Date().toISOString() } = {}) {
  const normalizedFiles = files.map(normalizeFile).sort((left, right) => left.path.localeCompare(right.path));
  const contentHash = hashJson(normalizedFiles.map(fileDescriptor));
  const bundle = { schemaVersion: 1, kind: FOLLOWER_SYSTEM_BUNDLE_KIND, releaseTarget: 'system_agent_follower',
    bundleId: `follower-system-${contentHash.slice(0, 24)}`, releaseVersion, minAppVersion, reportContractVersion,
    privacyValidatorVersion, sourceCandidateId: String(sourceCandidateId || ''), createdAt, contentHash,
    fileCount: normalizedFiles.length, files: normalizedFiles };
  bundle.sha256 = payloadHash(bundle);
  return bundle;
}

export function validateFollowerSystemAgentBundle(bundle, { appVersion = FOLLOWER_RELEASE_BASELINE_VERSION,
  reportContractVersion = 'follower_report_v2', privacyValidatorVersion = 'follower_privacy_v1' } = {}) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('Follower system bundle must be an object.');
  if (bundle.kind !== FOLLOWER_SYSTEM_BUNDLE_KIND || Number(bundle.schemaVersion) !== 1) throw new Error('Unsupported Follower system bundle contract.');
  if (bundle.releaseTarget !== 'system_agent_follower') throw new Error('Follower system bundle release target is invalid.');
  if (compareVersions(appVersion, bundle.minAppVersion) < 0) throw new Error('Follower system bundle requires a newer Janus version.');
  if (bundle.reportContractVersion !== reportContractVersion || bundle.privacyValidatorVersion !== privacyValidatorVersion) {
    throw new Error('Follower system bundle contract compatibility check failed.');
  }
  if (!Array.isArray(bundle.files) || !bundle.files.length) throw new Error('Follower system bundle contains no files.');
  const seen = new Set(); let bytes = 0;
  for (const item of bundle.files) {
    const file = normalizeFile(item);
    if (seen.has(file.path)) throw new Error(`Duplicate Follower system bundle path: ${file.path}`);
    seen.add(file.path); bytes += file.sizeBytes;
  }
  if (!seen.has('SKILL.md') || !seen.has('agent.json')) throw new Error('Follower system bundle is missing required assets.');
  if (bytes > MAX_BUNDLE_BYTES) throw new Error('Follower system bundle is too large.');
  const contentHash = hashJson(bundle.files.map(normalizeFile).sort((a, b) => a.path.localeCompare(b.path)).map(fileDescriptor));
  if (contentHash !== bundle.contentHash || bundle.bundleId !== `follower-system-${contentHash.slice(0, 24)}`) throw new Error('Follower system bundle content identity mismatch.');
  if (payloadHash(bundle) !== bundle.sha256) throw new Error('Follower system bundle payload hash mismatch.');
  return { bundleId: bundle.bundleId, contentHash, fileCount: seen.size, totalBytes: bytes };
}

export function signFollowerSystemAgentBundle(bundle, { privateKeyPem, keyId = '' } = {}) {
  validateFollowerSystemAgentBundle(bundle);
  if (!String(privateKeyPem || '').trim()) throw new Error('Follower system bundle signing key is missing.');
  const publicKey = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' });
  bundle.signatureAlgorithm = 'ed25519';
  bundle.signingKeyId = keyId || sha256(publicKey).slice(0, 16);
  bundle.signature = crypto.sign(null, Buffer.from(bundle.sha256, 'utf8'), privateKeyPem).toString('base64');
  return bundle;
}

export function verifyFollowerSystemAgentBundle(bundle, { publicKeyPem, requiredKeyId = '' } = {}) {
  if (bundle.signatureAlgorithm !== 'ed25519' || !bundle.signature) throw new Error('Follower system bundle is unsigned.');
  const canonical = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'pem' });
  const keyId = sha256(canonical).slice(0, 16);
  if ((requiredKeyId && bundle.signingKeyId !== requiredKeyId) || (bundle.signingKeyId && bundle.signingKeyId !== keyId)) {
    throw new Error('Follower system bundle signing key is not trusted.');
  }
  if (!crypto.verify(null, Buffer.from(bundle.sha256, 'utf8'), publicKeyPem, Buffer.from(bundle.signature, 'base64'))) {
    throw new Error('Follower system bundle signature verification failed.');
  }
  return { valid: true, signingKeyId: keyId };
}

export function applyFollowerSystemAgentBundle({ root, bundle, appVersion = FOLLOWER_RELEASE_BASELINE_VERSION } = {}) {
  validateFollowerSystemAgentBundle(bundle, { appVersion });
  const stateRoot = path.join(root, '.janus', 'system-agents', 'follower_agent');
  const versionsRoot = path.join(stateRoot, 'versions');
  const target = path.join(versionsRoot, bundle.bundleId);
  const staging = `${target}.staging-${process.pid}-${Date.now()}`;
  fs.mkdirSync(versionsRoot, { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    for (const item of bundle.files) writeTextAtomic(path.join(staging, normalizePath(item.path)), String(item.content || ''));
    writeJsonAtomic(path.join(staging, 'manifest.json'), { bundleId: bundle.bundleId, releaseVersion: bundle.releaseVersion,
      contentHash: bundle.contentHash, reportContractVersion: bundle.reportContractVersion,
      privacyValidatorVersion: bundle.privacyValidatorVersion, appliedAt: new Date().toISOString() });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    const previous = readFollowerSystemAgentBundle(root);
    const current = { bundleId: bundle.bundleId, releaseVersion: bundle.releaseVersion, contentHash: bundle.contentHash,
      activeRoot: target, previous: previous ? { bundleId: previous.bundleId, activeRoot: previous.activeRoot } : null,
      appliedAt: new Date().toISOString() };
    writeJsonAtomic(path.join(stateRoot, 'current.json'), current);
    return current;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function rollbackFollowerSystemAgentBundle({ root } = {}) {
  const stateRoot = path.join(root, '.janus', 'system-agents', 'follower_agent');
  const current = readFollowerSystemAgentBundle(root);
  if (!current?.previous?.activeRoot || !fs.existsSync(current.previous.activeRoot)) throw new Error('No compatible Follower system bundle rollback is available.');
  const restoredManifest = JSON.parse(fs.readFileSync(path.join(current.previous.activeRoot, 'manifest.json'), 'utf8'));
  const restored = { bundleId: restoredManifest.bundleId, releaseVersion: restoredManifest.releaseVersion,
    contentHash: restoredManifest.contentHash, activeRoot: current.previous.activeRoot, previous: null,
    appliedAt: new Date().toISOString(), rolledBackFrom: current.bundleId };
  writeJsonAtomic(path.join(stateRoot, 'current.json'), restored);
  return restored;
}

export function readFollowerSystemAgentBundle(root) {
  const file = path.join(root, '.janus', 'system-agents', 'follower_agent', 'current.json');
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { return null; }
}

export function followerEffectiveAssetPath(root, relativePath = 'SKILL.md') {
  const current = readFollowerSystemAgentBundle(root);
  const candidate = current?.activeRoot ? path.join(current.activeRoot, normalizePath(relativePath)) : '';
  return candidate && fs.existsSync(candidate) ? candidate : '';
}

function normalizeFile(value = {}) {
  const relativePath = normalizePath(value.path);
  const content = String(value.content ?? '');
  const sizeBytes = Buffer.byteLength(content);
  if (sizeBytes > MAX_FILE_BYTES) throw new Error(`Follower system bundle file is too large: ${relativePath}`);
  const fileHash = sha256(content);
  if (value.sha256 && value.sha256 !== fileHash) throw new Error(`Follower system bundle file hash mismatch: ${relativePath}`);
  if (value.sizeBytes != null && Number(value.sizeBytes) !== sizeBytes) throw new Error(`Follower system bundle file size mismatch: ${relativePath}`);
  return { path: relativePath, sha256: fileHash, sizeBytes, content };
}
function normalizePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!ALLOWED_FILES.has(normalized) || normalized.includes('\0') || normalized.split('/').includes('..') || path.isAbsolute(normalized)) throw new Error(`Unsafe Follower system bundle path: ${value}`);
  return normalized;
}
function fileDescriptor({ path: filePath, sha256: fileHash, sizeBytes }) { return { path: filePath, sha256: fileHash, sizeBytes }; }
function payloadHash(bundle) { const value = { ...bundle }; delete value.sha256; delete value.signature; delete value.signatureAlgorithm; delete value.signingKeyId; return hashJson(value); }
function hashJson(value) { return sha256(JSON.stringify(value)); }
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function writeTextAtomic(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.tmp-${process.pid}-${Date.now()}`; fs.writeFileSync(temp, content, 'utf8'); fs.renameSync(temp, file); }
function writeJsonAtomic(file, value) { writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`); }
function compareVersions(left, right) { const p = (v) => String(v || '0').split(/[.+-]/).slice(0, 3).map((x) => Number(x) || 0); const a = p(left); const b = p(right); for (let i = 0; i < 3; i += 1) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1; return 0; }
