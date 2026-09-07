import fs from 'node:fs';
import path from 'node:path';

import { decryptTrialProviderBundle } from './trialProviderBundle.js';

let cachedPath = '';
let cachedMtimeMs = -1;
let cachedResult = null;
let configuredBundlePath = '';

export function embeddedTrialProviderPath(resourcesPath = process.resourcesPath || '') {
  if (configuredBundlePath) return configuredBundlePath;
  const root = String(resourcesPath || '').trim();
  return root ? path.join(root, 'trial-provider', 'provider.enc') : '';
}

export function configureEmbeddedTrialProviderPath(bundlePath = '') {
  configuredBundlePath = String(bundlePath || '').trim();
  clearEmbeddedTrialProviderCache();
  return configuredBundlePath;
}

export function loadEmbeddedTrialProvider({ bundlePath = embeddedTrialProviderPath(), fresh = false } = {}) {
  const target = String(bundlePath || '').trim();
  if (!target || !fs.existsSync(target)) {
    return { available: false, apiKey: '', baseUrl: '', source: 'missing', error: '' };
  }
  try {
    const stat = fs.statSync(target);
    if (!fresh && cachedResult && cachedPath === target && cachedMtimeMs === stat.mtimeMs) return { ...cachedResult };
    const bundle = JSON.parse(fs.readFileSync(target, 'utf8'));
    const decrypted = decryptTrialProviderBundle(bundle);
    const result = decrypted.available
      ? { ...decrypted, source: 'embedded', error: '' }
      : { available: false, apiKey: '', baseUrl: '', distributionMode: decrypted.distributionMode, source: 'disabled', error: '' };
    cachedPath = target;
    cachedMtimeMs = stat.mtimeMs;
    cachedResult = result;
    return { ...result };
  } catch (error) {
    return {
      available: false,
      apiKey: '',
      baseUrl: '',
      distributionMode: 'open-source',
      source: 'invalid',
      error: error?.message || String(error),
    };
  }
}

export function loadDevelopmentTrialProvider(env = process.env) {
  if (String(env.JANUS_DEV_TRIAL_PROVIDER || '').trim() !== '1') {
    return { available: false, apiKey: '', baseUrl: '', source: 'development-disabled', error: '' };
  }
  try {
    const directKey = String(env.JANUS_TRIAL_CODEX_KEY || '').trim();
    const keyFile = String(env.JANUS_TRIAL_CODEX_KEY_FILE || '').trim();
    if (directKey && keyFile) throw new Error('Set only one development trial Provider Key source.');
    const apiKey = directKey || (keyFile ? fs.readFileSync(path.resolve(keyFile), 'utf8').trim() : '');
    const baseUrl = normalizeDevelopmentBaseUrl(env.JANUS_TRIAL_CODEX_BASE_URL || '');
    if ((!apiKey || !baseUrl) && (apiKey || baseUrl)) {
      throw new Error('Development trial Provider requires both Key and Base URL.');
    }
    return apiKey
      ? { available: true, apiKey, baseUrl, distributionMode: 'open-source', source: 'development', error: '' }
      : { available: false, apiKey: '', baseUrl: '', source: 'development-missing', error: '' };
  } catch (error) {
    return {
      available: false,
      apiKey: '',
      baseUrl: '',
      source: 'development-invalid',
      error: error?.message || String(error),
    };
  }
}

export function clearEmbeddedTrialProviderCache() {
  cachedPath = '';
  cachedMtimeMs = -1;
  cachedResult = null;
}

function normalizeDevelopmentBaseUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const url = new URL(text);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('Development trial Provider Base URL must use HTTP(S).');
  }
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}
