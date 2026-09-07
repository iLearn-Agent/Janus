import crypto from 'node:crypto';
import fs from 'node:fs';

const UPDATE_SIGNATURE_SCHEMA_VERSION = 1;

export function updateSignaturePayload({ version = '', file = '', sha512 = '', size = 0 } = {}) {
  const normalized = {
    schemaVersion: UPDATE_SIGNATURE_SCHEMA_VERSION,
    version: String(version || '').trim(),
    file: String(file || '').trim(),
    sha512: String(sha512 || '').trim(),
    size: Number(size),
  };
  if (!normalized.version || !normalized.file || !normalized.sha512 || !Number.isSafeInteger(normalized.size) || normalized.size <= 0) {
    throw new Error('Update signature metadata is incomplete.');
  }
  return [
    'janus-desktop-update-v1',
    `version=${normalized.version}`,
    `file=${normalized.file}`,
    `sha512=${normalized.sha512}`,
    `size=${normalized.size}`,
    '',
  ].join('\n');
}

export function updateSigningKeyId(keyPem) {
  const key = keyPem?.type === 'public' ? keyPem : crypto.createPublicKey(keyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export function signUpdateMetadata(metadata, privateKeyPem) {
  if (!String(privateKeyPem || '').trim()) throw new Error('Update signing private key is missing.');
  const publicKey = crypto.createPublicKey(privateKeyPem);
  return {
    schemaVersion: UPDATE_SIGNATURE_SCHEMA_VERSION,
    algorithm: 'ed25519',
    keyId: updateSigningKeyId(publicKey),
    version: String(metadata.version || '').trim(),
    file: String(metadata.file || '').trim(),
    sha512: String(metadata.sha512 || '').trim(),
    size: Number(metadata.size),
    signature: crypto.sign(null, Buffer.from(updateSignaturePayload(metadata), 'utf8'), privateKeyPem).toString('base64'),
  };
}

export function verifyUpdateMetadata(metadata, publicKeyPem) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Update signature metadata is missing.');
  if (Number(metadata.schemaVersion) !== UPDATE_SIGNATURE_SCHEMA_VERSION) throw new Error('Unsupported update signature schema.');
  if (metadata.algorithm !== 'ed25519') throw new Error('Unsupported update signature algorithm.');
  if (!String(publicKeyPem || '').trim()) throw new Error('Update verification public key is missing.');
  const keyId = updateSigningKeyId(publicKeyPem);
  if (metadata.keyId !== keyId) throw new Error('Update signing key is not trusted.');
  const valid = crypto.verify(
    null,
    Buffer.from(updateSignaturePayload(metadata), 'utf8'),
    publicKeyPem,
    Buffer.from(String(metadata.signature || ''), 'base64'),
  );
  if (!valid) throw new Error('Update package signature verification failed.');
  return { valid: true, keyId };
}

export function sha512File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    const input = fs.createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('base64')));
  });
}

export function checksumsEqual(left = '', right = '') {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function readUpdateSignatureManifest(text = '') {
  const source = String(text || '');
  return {
    installMode: yamlManifestValue(source, 'janusInstallMode', 0),
    metadata: {
      schemaVersion: Number(yamlManifestValue(source, 'schemaVersion', 2)),
      algorithm: yamlManifestValue(source, 'algorithm', 2),
      keyId: yamlManifestValue(source, 'keyId', 2),
      version: yamlManifestValue(source, 'version', 2),
      file: yamlManifestValue(source, 'file', 2),
      sha512: yamlManifestValue(source, 'sha512', 2),
      size: Number(yamlManifestValue(source, 'size', 2)),
      signature: yamlManifestValue(source, 'signature', 2),
    },
  };
}

export const readMacUpdateSignatureManifest = readUpdateSignatureManifest;

function yamlManifestValue(text, key, indent) {
  const prefix = `^${' '.repeat(indent)}${key}:\\s*(.*?)\\s*$`;
  const match = text.match(new RegExp(prefix, 'm'));
  if (!match) return '';
  const value = match[1].trim();
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1).replace(value.startsWith("'") ? /''/g : /\\"/g, value.startsWith("'") ? "'" : '"');
  }
  return value;
}
