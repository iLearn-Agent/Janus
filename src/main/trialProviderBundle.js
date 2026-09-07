import crypto from 'node:crypto';

const FORMAT_VERSION = 1;
const ALGORITHM = 'aes-256-gcm-obfuscation';
const KEY_NAMESPACE = 'janus-trial-provider-v1';

export function encryptTrialProviderPayload({
  apiKey = '',
  baseUrl = '',
  appId = 'local.janus.desktop',
  appVersion = '',
  distributionMode = 'open-source',
} = {}) {
  const cleanApiKey = String(apiKey || '').trim();
  const cleanBaseUrl = normalizeProviderBaseUrl(baseUrl);
  const cleanAppId = String(appId || 'local.janus.desktop').trim() || 'local.janus.desktop';
  const cleanAppVersion = String(appVersion || '').trim();
  if (!cleanApiKey) throw new Error('JANUS_TRIAL_CODEX_KEY is required.');
  if (!cleanAppVersion) throw new Error('The application version is required for the trial Provider bundle.');

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveBundleKey({ appId: cleanAppId, appVersion: cleanAppVersion, salt });
  const aad = bundleAad({ appId: cleanAppId, appVersion: cleanAppVersion });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify({
    apiKey: cleanApiKey,
    baseUrl: cleanBaseUrl,
  }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    formatVersion: FORMAT_VERSION,
    algorithm: ALGORITHM,
    distributionMode: normalizeDistributionMode(distributionMode),
    appId: cleanAppId,
    appVersion: cleanAppVersion,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptTrialProviderBundle(bundle = {}) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('Trial Provider bundle must be a JSON object.');
  }
  const distributionMode = normalizeDistributionMode(bundle.distributionMode || (bundle.enabled === false ? 'open-source' : 'open-source'));
  if (bundle.enabled === false) return { available: false, apiKey: '', baseUrl: '', distributionMode };
  if (Number(bundle.formatVersion) !== FORMAT_VERSION || bundle.algorithm !== ALGORITHM) {
    throw new Error('Unsupported trial Provider bundle format.');
  }
  const appId = String(bundle.appId || '').trim();
  const appVersion = String(bundle.appVersion || '').trim();
  if (!appId || !appVersion) throw new Error('Trial Provider bundle identity is incomplete.');
  const salt = decodeBundleField(bundle.salt, 'salt');
  const iv = decodeBundleField(bundle.iv, 'iv');
  const tag = decodeBundleField(bundle.tag, 'tag');
  const ciphertext = decodeBundleField(bundle.ciphertext, 'ciphertext');
  const key = deriveBundleKey({ appId, appVersion, salt });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(bundleAad({ appId, appVersion }));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const payload = JSON.parse(plaintext.toString('utf8'));
  const apiKey = String(payload?.apiKey || '').trim();
  const baseUrl = normalizeProviderBaseUrl(payload?.baseUrl || '');
  if (!apiKey) throw new Error('Trial Provider bundle does not contain an API Key.');
  return { available: true, apiKey, baseUrl, appId, appVersion, distributionMode };
}

function deriveBundleKey({ appId, appVersion, salt }) {
  // This intentionally provides packaging obfuscation, not a secure client-side secret boundary.
  // A determined local user can reconstruct the key derivation from the open-source application.
  return crypto.scryptSync(`${KEY_NAMESPACE}:${appId}:${appVersion}`, salt, 32);
}

function bundleAad({ appId, appVersion }) {
  return Buffer.from(`${KEY_NAMESPACE}:${appId}:${appVersion}`, 'utf8');
}

function normalizeProviderBaseUrl(value = '') {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('JANUS_TRIAL_CODEX_BASE_URL must be an HTTP(S) URL.');
  }
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function decodeBundleField(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`Trial Provider bundle ${name} is missing.`);
  return Buffer.from(text, 'base64');
}

function normalizeDistributionMode(value = '') {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'open-source') return 'open-source';
  if (mode === 'open-source') return 'open-source';
  throw new Error(`Unsupported Janus distribution mode: ${mode || '(empty)'}.`);
}
