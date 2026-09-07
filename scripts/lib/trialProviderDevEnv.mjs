import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CLOUD_HOME = '/home/ubuntu/janus-cloud';
const TRIAL_PROVIDER_ENV_NAMES = [
  'JANUS_TRIAL_CODEX_KEY',
  'JANUS_TRIAL_CODEX_KEY_FILE',
  'JANUS_TRIAL_CODEX_BASE_URL',
  'JANUS_TRIAL_PROVIDER_REQUIRED',
  'JANUS_ALLOW_OFFICIAL_PROVIDER_EMBED',
  'JANUS_PROVIDER_KEY_DISTRIBUTION_KEY',
  'JANUS_PROVIDER_KEY_DISTRIBUTION_BASE_URL',
  'JANUS_DISTRIBUTION_MODE',
];

export function loadTrialProviderDevEnvironment(sourceEnv = process.env) {
  const mode = String(sourceEnv.JANUS_DISTRIBUTION_MODE || 'open-source').trim().toLowerCase();
  if (mode === 'open-source') {
    const env = { ...sourceEnv, JANUS_DISTRIBUTION_MODE: 'open-source' };
    for (const name of [
      'JANUS_TRIAL_CODEX_KEY',
      'JANUS_TRIAL_CODEX_KEY_FILE',
      'JANUS_TRIAL_CODEX_BASE_URL',
      'JANUS_TRIAL_PROVIDER_REQUIRED',
      'JANUS_ALLOW_OFFICIAL_PROVIDER_EMBED',
      'JANUS_PROVIDER_KEY_DISTRIBUTION_KEY',
      'JANUS_PROVIDER_KEY_DISTRIBUTION_BASE_URL',
      'JANUS_DEV_TRIAL_PROVIDER',
    ]) delete env[name];
    return env;
  }
  return loadTrialProviderEnvironment({
    ...sourceEnv,
    JANUS_DISTRIBUTION_MODE: 'open-source',
  }, { markDevelopment: true });
}

export function loadTrialProviderEnvironment(sourceEnv = process.env, { markDevelopment = false } = {}) {
  const env = { ...sourceEnv };
  const cloudHome = String(env.JANUS_CLOUD_HOME || DEFAULT_CLOUD_HOME).trim() || DEFAULT_CLOUD_HOME;
  const explicitEnvFile = String(env.JANUS_TRIAL_PROVIDER_ENV_FILE || env.JANUS_DEV_TRIAL_PROVIDER_ENV_FILE || '').trim();
  const envFile = path.resolve(explicitEnvFile || path.join(cloudHome, '.env'));
  const values = fs.existsSync(envFile) ? parseEnvFile(fs.readFileSync(envFile, 'utf8')) : {};

  if (!String(env.JANUS_DISTRIBUTION_MODE || '').trim() && values.JANUS_DISTRIBUTION_MODE) {
    env.JANUS_DISTRIBUTION_MODE = values.JANUS_DISTRIBUTION_MODE;
  }

  const configuredBaseUrl = String(
    env.JANUS_TRIAL_CODEX_BASE_URL
    || env.JANUS_PROVIDER_KEY_DISTRIBUTION_BASE_URL
    || values.JANUS_TRIAL_CODEX_BASE_URL
    || values.JANUS_PROVIDER_KEY_DISTRIBUTION_BASE_URL
    || '',
  ).trim();
  if (configuredBaseUrl) env.JANUS_TRIAL_CODEX_BASE_URL = configuredBaseUrl;
  let directKey = String(env.JANUS_TRIAL_CODEX_KEY || env.JANUS_PROVIDER_KEY_DISTRIBUTION_KEY || '').trim();
  let keyFile = String(env.JANUS_TRIAL_CODEX_KEY_FILE || '').trim();
  if (!directKey && !keyFile) {
    directKey = String(values.JANUS_TRIAL_CODEX_KEY || values.JANUS_PROVIDER_KEY_DISTRIBUTION_KEY || '').trim();
    keyFile = String(values.JANUS_TRIAL_CODEX_KEY_FILE || '').trim();
    if (keyFile && !path.isAbsolute(keyFile)) keyFile = path.resolve(path.dirname(envFile), keyFile);
    if (directKey) env.JANUS_TRIAL_CODEX_KEY = directKey;
    else if (keyFile) env.JANUS_TRIAL_CODEX_KEY_FILE = keyFile;
  }
  if (directKey && keyFile) throw new Error('Trial Provider has both direct and file-based Keys configured.');

  if (directKey) env.JANUS_TRIAL_CODEX_KEY = directKey;
  const baseUrl = String(env.JANUS_TRIAL_CODEX_BASE_URL || '').trim();
  const hasKey = Boolean(directKey || keyFile);
  if (hasKey !== Boolean(baseUrl)) {
    throw new Error('Trial Provider requires both Key and Base URL in the cloud .env file.');
  }
  if (!String(env.JANUS_TRIAL_PROVIDER_REQUIRED || '').trim() && values.JANUS_TRIAL_PROVIDER_REQUIRED) {
    env.JANUS_TRIAL_PROVIDER_REQUIRED = values.JANUS_TRIAL_PROVIDER_REQUIRED;
  }
  if (!String(env.JANUS_ALLOW_OFFICIAL_PROVIDER_EMBED || '').trim() && values.JANUS_ALLOW_OFFICIAL_PROVIDER_EMBED) {
    env.JANUS_ALLOW_OFFICIAL_PROVIDER_EMBED = values.JANUS_ALLOW_OFFICIAL_PROVIDER_EMBED;
  }
  delete env.JANUS_PROVIDER_KEY_DISTRIBUTION_KEY;
  delete env.JANUS_PROVIDER_KEY_DISTRIBUTION_BASE_URL;
  if (hasKey && markDevelopment) env.JANUS_DEV_TRIAL_PROVIDER = '1';
  return env;
}

export function parseEnvFile(text = '') {
  const output = {};
  for (const rawLine of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const name = match[1];
    if (!TRIAL_PROVIDER_ENV_NAMES.includes(name)) continue;
    output[name] = parseEnvValue(match[2]);
  }
  return output;
}

function parseEnvValue(value = '') {
  const text = String(value || '').trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return text.replace(/\s+#.*$/, '').trim();
}
