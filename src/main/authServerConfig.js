import fs from 'node:fs';
import path from 'node:path';

import { assetRoot } from './paths.js';

export function packagedAuthServerUrl({ explicitUrl = process.env.JANUS_PACKAGED_AUTH_URL } = {}) {
  const explicit = normalizeAuthServerUrl(explicitUrl);
  if (explicit) return explicit;
  return packagedAuthDefaults().serverUrl;
}

export function packagedAuthUserId({ explicitUserId = process.env.JANUS_PACKAGED_CLOUD_USER_ID } = {}) {
  const explicit = String(explicitUserId || '').trim();
  if (explicit) return explicit;
  return packagedAuthDefaults().userId;
}

function packagedAuthDefaults() {
  try {
    const defaults = JSON.parse(fs.readFileSync(path.join(assetRoot, 'auth-defaults.json'), 'utf8'));
    return {
      serverUrl: normalizeAuthServerUrl(defaults?.serverUrl || defaults?.server_url || ''),
      userId: String(defaults?.userId || defaults?.user_id || '').trim(),
    };
  } catch {
    return { serverUrl: '', userId: '' };
  }
}

export function normalizeAuthServerUrl(value = '') {
  const text = String(value || '').trim().replace(/\/+$/g, '');
  if (!text) return '';
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname ? url.toString().replace(/\/+$/g, '') : '';
  } catch {
    return '';
  }
}
