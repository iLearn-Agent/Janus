#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encryptTrialProviderPayload } from '../src/main/trialProviderBundle.js';
import { loadTrialProviderEnvironment } from './lib/trialProviderDevEnv.mjs';

const projectRoot = path.resolve(argumentValue('--root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
const outputPath = path.resolve(argumentValue('--output', path.join(projectRoot, 'build-runtime', 'trial-provider', 'provider.enc')));
const packageJson = JSON.parse(await fsp.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const appId = String(packageJson.build?.appId || 'local.janus.desktop').trim() || 'local.janus.desktop';
const appVersion = String(packageJson.version || '').trim();
const distributionMode = resolveDistributionMode(process.env.JANUS_DISTRIBUTION_MODE);
const buildEnv = distributionMode === 'open-source'
  ? loadTrialProviderEnvironment(process.env)
  : withoutProviderCredentials(process.env);
const apiKey = secretValue('JANUS_TRIAL_CODEX_KEY', 'JANUS_TRIAL_CODEX_KEY_FILE', buildEnv);
const baseUrl = String(buildEnv.JANUS_TRIAL_CODEX_BASE_URL || '').trim();
const required = String(buildEnv.JANUS_TRIAL_PROVIDER_REQUIRED || '').trim() === '1';
const officialProviderEmbedAcknowledged = String(buildEnv.JANUS_ALLOW_OFFICIAL_PROVIDER_EMBED || '').trim()
  === 'I_UNDERSTAND_THIS_KEY_CAN_BE_EXTRACTED';

if ((!apiKey || !baseUrl) && (apiKey || baseUrl)) {
  throw new Error('Set both JANUS_TRIAL_CODEX_KEY and JANUS_TRIAL_CODEX_BASE_URL, or set neither.');
}
if (distributionMode === 'open-source' && !apiKey && required) {
  throw new Error('Trial Provider credentials are required for this package, but were not supplied.');
}
if (distributionMode === 'open-source') {
  const officialCredential = validateInternalGatewayCredential({
    apiKey,
    baseUrl,
    allowOfficialProvider: officialProviderEmbedAcknowledged,
  });
  if (officialCredential) {
    process.stderr.write('WARNING: embedding an official-looking Provider credential that can be extracted from the desktop package.\n');
  }
}

const bundle = apiKey
  ? encryptTrialProviderPayload({ apiKey, baseUrl, appId, appVersion, distributionMode })
  : { formatVersion: 1, enabled: false, distributionMode, appId, appVersion };

await fsp.mkdir(path.dirname(outputPath), { recursive: true });
await fsp.writeFile(outputPath, `${JSON.stringify(bundle)}\n`, { encoding: 'utf8', mode: 0o600 });
await fsp.chmod(outputPath, 0o600).catch(() => {});
process.stdout.write(apiKey
  ? `Prepared internal embedded Provider bundle for Janus ${appVersion}.\n`
  : `Prepared open-source configurable Provider bundle for Janus ${appVersion}.\n`);

function secretValue(valueName, fileName, env = process.env) {
  const direct = String(env[valueName] || '').trim();
  const filename = String(env[fileName] || '').trim();
  if (direct && filename) throw new Error(`Set only one of ${valueName} or ${fileName}.`);
  if (!filename) return direct;
  const resolved = path.resolve(filename);
  if (!fs.existsSync(resolved)) throw new Error(`${fileName} does not exist: ${resolved}`);
  return fs.readFileSync(resolved, 'utf8').trim();
}

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function resolveDistributionMode(value = '') {
  const mode = String(value || '').trim().toLowerCase();
  if (!mode || mode === 'auto') return 'open-source';
  if (['open-source', 'open-source'].includes(mode)) return mode;
  throw new Error(`JANUS_DISTRIBUTION_MODE must be open-source or open-source, received ${mode}.`);
}

function withoutProviderCredentials(sourceEnv = {}) {
  const env = { ...sourceEnv, JANUS_DISTRIBUTION_MODE: 'open-source' };
  for (const name of [
    'JANUS_TRIAL_CODEX_KEY',
    'JANUS_TRIAL_CODEX_KEY_FILE',
    'JANUS_TRIAL_CODEX_BASE_URL',
    'JANUS_TRIAL_PROVIDER_REQUIRED',
    'JANUS_ALLOW_OFFICIAL_PROVIDER_EMBED',
  ]) delete env[name];
  return env;
}

function validateInternalGatewayCredential({ apiKey = '', baseUrl = '', allowOfficialProvider = false } = {}) {
  if (!apiKey || !baseUrl) throw new Error('Internal embedded packages require a gateway Key and Base URL.');
  const url = new URL(baseUrl);
  const hostname = url.hostname.toLowerCase();
  const officialEndpoint = hostname === 'openai.com' || hostname.endsWith('.openai.com')
    || hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com');
  const officialLookingKey = /^sk-(?:proj-)?/i.test(String(apiKey || '').trim());
  if (officialEndpoint && !allowOfficialProvider) {
    throw new Error('Refusing to embed credentials for an official OpenAI/Codex endpoint. Use an Janus-controlled gateway URL.');
  }
  if (officialLookingKey && !allowOfficialProvider) {
    throw new Error('Refusing to embed a Key that looks like an official OpenAI API Key. Issue an Janus gateway Key instead.');
  }
  return officialEndpoint || officialLookingKey;
}
