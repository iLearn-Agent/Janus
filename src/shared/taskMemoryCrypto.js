import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CONTENT_ALGORITHM = 'aes-256-gcm';
const LOCAL_WRAP_ALGORITHM = 'aes-256-gcm';
const CLOUD_WRAP_ALGORITHM = 'rsa-oaep-sha256';
const DEVICE_KEY_VERSION = 2;

export class LocalTaskMemoryKeyring {
  constructor({ root = '', keyFilePath = '' } = {}) {
    this.keyFilePath = keyFilePath || taskMemoryDeviceKeyPath(root);
    this.cached = null;
  }

  available() {
    return Boolean(this.keyFilePath);
  }

  deviceKey() {
    if (this.cached) return this.cached;
    if (!this.keyFilePath) throw new Error('Task Memory local key storage is not configured.');
    fs.mkdirSync(path.dirname(this.keyFilePath), { recursive: true });
    try {
      const parsed = JSON.parse(fs.readFileSync(this.keyFilePath, 'utf8'));
      const key = decodeAesKey(parsed.key);
      this.cached = { keyId: String(parsed.keyId || ''), key };
      if (!this.cached.keyId) throw new Error('Task Memory device key ID is missing.');
      return this.cached;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const record = { keyId: `device_task_kek_${crypto.randomUUID()}`, key: crypto.randomBytes(32).toString('base64'), createdAt: new Date().toISOString() };
    try {
      fs.writeFileSync(this.keyFilePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return this.deviceKeyFromDisk();
    }
    this.cached = { keyId: record.keyId, key: decodeAesKey(record.key) };
    return this.cached;
  }

  deviceKeyFromDisk() {
    const parsed = JSON.parse(fs.readFileSync(this.keyFilePath, 'utf8'));
    this.cached = { keyId: String(parsed.keyId || ''), key: decodeAesKey(parsed.key) };
    if (!this.cached.keyId) throw new Error('Task Memory device key ID is missing.');
    return this.cached;
  }

  wrapTaskKey(dataKey, { taskRunId = '', keyVersion = 1 } = {}) {
    const device = this.deviceKey();
    const aad = localEnvelopeAad({ taskRunId, keyVersion, wrappingKeyId: device.keyId });
    const encrypted = encryptAesGcm(dataKey, device.key, aad);
    return { algorithm: LOCAL_WRAP_ALGORITHM, wrappingKeyId: device.keyId, ...encrypted };
  }

  unwrapTaskKey(record = {}, { taskRunId = '', keyVersion = 1 } = {}) {
    if (record.algorithm !== LOCAL_WRAP_ALGORITHM) throw new Error(`Unsupported local task key envelope: ${record.algorithm || 'missing'}`);
    const device = this.deviceKey();
    if (record.wrappingKeyId !== device.keyId) throw new Error('Task Memory belongs to a different local device key.');
    return decryptAesGcm(record, device.key, localEnvelopeAad({ taskRunId, keyVersion, wrappingKeyId: device.keyId }));
  }

  recoveryIdentity() {
    const record = this.ensureRecoveryIdentity();
    return {
      algorithm: CLOUD_WRAP_ALGORITHM,
      publicKey: record.recoveryPublicKey,
      publicKeyFingerprint: record.recoveryKeyFingerprint,
    };
  }

  signDeviceGrantProof({ userId = '', deviceId = '', scopes = [], timestamp = new Date().toISOString(), nonce = crypto.randomUUID() } = {}) {
    const identity = this.ensureRecoveryIdentity();
    const message = deviceGrantProofMessage({ userId, deviceId, scopes, timestamp, nonce });
    const signature = crypto.sign('sha256', Buffer.from(message, 'utf8'), identity.recoveryPrivateKey).toString('base64');
    return { timestamp, nonce, signature, publicKeyFingerprint: identity.recoveryKeyFingerprint };
  }

  unwrapRecoveredTaskKey(record = {}) {
    const identity = this.ensureRecoveryIdentity();
    return unwrapTaskKeyFromDevice(record, {
      privateKey: identity.recoveryPrivateKey,
      publicKeyFingerprint: identity.recoveryKeyFingerprint,
    });
  }

  rewrapRecoveredTaskKey(record = {}, { taskRunId = '', keyVersion = 1 } = {}) {
    return this.wrapTaskKey(this.unwrapRecoveredTaskKey(record), { taskRunId, keyVersion });
  }

  ensureRecoveryIdentity() {
    this.deviceKey();
    const parsed = JSON.parse(fs.readFileSync(this.keyFilePath, 'utf8'));
    if (parsed.recoveryPrivateKey && parsed.recoveryPublicKey && parsed.recoveryKeyFingerprint) return parsed;
    const recovery = createDeviceRecoveryKeyPair();
    const upgraded = {
      ...parsed,
      version: DEVICE_KEY_VERSION,
      recoveryAlgorithm: CLOUD_WRAP_ALGORITHM,
      recoveryPrivateKey: recovery.privateKey,
      recoveryPublicKey: recovery.publicKey,
      recoveryKeyFingerprint: recovery.publicKeyFingerprint,
      recoveryCreatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.keyFilePath, `${JSON.stringify(upgraded, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return upgraded;
  }
}

export function taskMemoryDeviceKeyPath(root = '') {
  return root ? path.join(root, 'data', 'task-memory-device-key.json') : '';
}

export function encryptTaskMemoryContent(content, dataKey, { documentId = '', versionNo = 1, keyVersion = 1 } = {}) {
  const aad = taskContentAad({ documentId, versionNo, keyVersion });
  return { algorithm: CONTENT_ALGORITHM, aad, ...encryptAesGcm(Buffer.from(String(content || ''), 'utf8'), decodeAesKey(dataKey), aad) };
}

export function decryptTaskMemoryContent(record = {}, dataKey) {
  if (record.algorithm !== CONTENT_ALGORITHM) throw new Error(`Unsupported task Memory encryption: ${record.algorithm || 'missing'}`);
  return decryptAesGcm(record, decodeAesKey(dataKey), String(record.aad || '')).toString('utf8');
}

export function cloudTaskMemoryPublicKeyringFromEnv(env = process.env) {
  return asymmetricKeyringFromEnv(env.JANUS_TASK_MEMORY_CLOUD_PUBLIC_KEYS_JSON, env.JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID);
}

export function cloudTaskMemoryPrivateKeyringFromEnv(env = process.env) {
  return asymmetricKeyringFromEnv(env.JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON, env.JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID);
}

export function cloudTaskMemoryEnvelopeCapability(keyring = cloudTaskMemoryPublicKeyringFromEnv()) {
  const keyId = String(keyring.activeKeyId || '');
  const publicKey = keyring.keys?.[keyId];
  return { available: Boolean(keyId && publicKey), activeKeyId: keyId, publicKey: publicKey || '' };
}

export function wrapTaskKeyForCloud(dataKey, keyring = cloudTaskMemoryPublicKeyringFromEnv()) {
  const keyId = String(keyring.activeKeyId || '');
  const publicKey = keyring.keys?.[keyId];
  if (!keyId || !publicKey) throw new Error('Cloud task Memory public key is not configured.');
  const wrappedKey = crypto.publicEncrypt({ key: publicKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, decodeAesKey(dataKey));
  return { algorithm: CLOUD_WRAP_ALGORITHM, keyId, wrappedKey: wrappedKey.toString('base64') };
}

export function unwrapTaskKeyFromCloud(record = {}, keyring = cloudTaskMemoryPrivateKeyringFromEnv()) {
  if (record.algorithm !== CLOUD_WRAP_ALGORITHM) throw new Error(`Unsupported cloud task key envelope: ${record.algorithm || 'missing'}`);
  const privateKey = keyring.keys?.[record.keyId];
  if (!privateKey) throw new Error(`Cloud task Memory private key is unavailable: ${record.keyId || 'missing'}`);
  const key = crypto.privateDecrypt({ key: privateKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(record.wrappedKey || '', 'base64'));
  return decodeAesKey(key);
}

export function wrapTaskKeyForDevice(dataKey, { publicKey = '', publicKeyFingerprint = '' } = {}) {
  if (!publicKey) throw new Error('Device task Memory public key is unavailable.');
  const fingerprint = publicKeyFingerprint || rsaPublicKeyFingerprint(publicKey);
  const wrappedKey = crypto.publicEncrypt({
    key: publicKey,
    oaepHash: 'sha256',
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
  }, decodeAesKey(dataKey));
  return { algorithm: CLOUD_WRAP_ALGORITHM, publicKeyFingerprint: fingerprint, wrappedKey: wrappedKey.toString('base64') };
}

export function unwrapTaskKeyFromDevice(record = {}, { privateKey = '', publicKeyFingerprint = '' } = {}) {
  if (record.algorithm !== CLOUD_WRAP_ALGORITHM) throw new Error(`Unsupported device task key envelope: ${record.algorithm || 'missing'}`);
  if (!privateKey) throw new Error('Device task Memory private key is unavailable.');
  if (publicKeyFingerprint && record.publicKeyFingerprint !== publicKeyFingerprint) {
    throw new Error('Task Memory recovery envelope belongs to a different device key.');
  }
  const key = crypto.privateDecrypt({
    key: privateKey,
    oaepHash: 'sha256',
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
  }, Buffer.from(record.wrappedKey || '', 'base64'));
  return decodeAesKey(key);
}

export function rsaPublicKeyFingerprint(publicKey) {
  const key = crypto.createPublicKey(publicKey);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

export function deviceGrantProofMessage({ userId = '', deviceId = '', scopes = [], timestamp = '', nonce = '' } = {}) {
  return ['janus-device-grant-v6', String(userId), String(deviceId), String(timestamp), String(nonce),
    [...new Set((Array.isArray(scopes) ? scopes : []).map(String))].sort().join(',')].join('\n');
}

function encryptAesGcm(value, key, aad = '') {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CONTENT_ALGORITHM, key, nonce);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decryptAesGcm(record, key, aad = '') {
  const decipher = crypto.createDecipheriv(CONTENT_ALGORITHM, key, Buffer.from(record.nonce || '', 'base64'));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(record.tag || '', 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext || '', 'base64')), decipher.final()]);
}

function localEnvelopeAad({ taskRunId, keyVersion, wrappingKeyId }) {
  return `janus:task-key:${taskRunId}:${Number(keyVersion || 1)}:${wrappingKeyId}`;
}

function taskContentAad({ documentId, versionNo, keyVersion }) {
  return `janus:task-memory:${documentId}:${Number(versionNo || 1)}:${Number(keyVersion || 1)}`;
}

function asymmetricKeyringFromEnv(json = '', activeKeyId = '') {
  let keys = {};
  try { keys = JSON.parse(json || '{}'); } catch { keys = {}; }
  return { activeKeyId: String(activeKeyId || Object.keys(keys)[0] || '').trim(), keys };
}

function createDeviceRecoveryKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  return {
    publicKey: publicPem,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyFingerprint: rsaPublicKeyFingerprint(publicPem),
  };
}

function decodeAesKey(value) {
  const key = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'base64');
  if (key.length !== 32) throw new Error('Task Memory keys must be exactly 32 bytes.');
  return key;
}
