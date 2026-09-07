#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codexConfigStatus, loadAuthEnv, setCodexStoredProviderValidation } from '../src/main/codexConfig.js';
import { loadDevelopmentTrialProvider } from '../src/main/trialProvider.js';
import { loadTrialProviderDevEnvironment, parseEnvFile } from './lib/trialProviderDevEnv.mjs';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-dev-trial-provider-'));
const envPath = path.join(tempRoot, '.env');
const runtimeRoot = path.join(tempRoot, 'runtime');
const apiKey = 'sk-dev-trial-provider-smoke';
const baseUrl = 'https://dev-provider.example/v1';
const trackedEnvNames = [
  'JANUS_DEV_TRIAL_PROVIDER_ENV_FILE',
  'JANUS_DEV_TRIAL_PROVIDER',
  'JANUS_DISTRIBUTION_MODE',
  'JANUS_TRIAL_CODEX_KEY',
  'JANUS_TRIAL_CODEX_KEY_FILE',
  'JANUS_TRIAL_CODEX_BASE_URL',
  'JANUS_PROVIDER_KEY_DISTRIBUTION_KEY',
  'JANUS_PROVIDER_KEY_DISTRIBUTION_BASE_URL',
];
const priorEnv = Object.fromEntries(trackedEnvNames.map((name) => [name, process.env[name]]));

try {
  fs.writeFileSync(envPath, [
    '# cloud secrets outside the allowlist must not enter Electron',
    'DATABASE_URL=postgres://private.example/janus',
    `JANUS_PROVIDER_KEY_DISTRIBUTION_KEY='${apiKey}'`,
    `JANUS_PROVIDER_KEY_DISTRIBUTION_BASE_URL="${baseUrl}"`,
    '',
  ].join('\n'));
  const parsed = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  assert.equal(parsed.JANUS_PROVIDER_KEY_DISTRIBUTION_KEY, apiKey);
  assert.equal(parsed.JANUS_PROVIDER_KEY_DISTRIBUTION_BASE_URL, baseUrl);
  assert.equal(parsed.DATABASE_URL, undefined);

  const defaultEnv = loadTrialProviderDevEnvironment({
    JANUS_DEV_TRIAL_PROVIDER_ENV_FILE: envPath,
  });
  assert.equal(defaultEnv.JANUS_DISTRIBUTION_MODE, 'open-source');
  assert.equal(defaultEnv.JANUS_DEV_TRIAL_PROVIDER, '1');
  assert.equal(defaultEnv.JANUS_TRIAL_CODEX_KEY, apiKey);
  assert.equal(defaultEnv.JANUS_PROVIDER_KEY_DISTRIBUTION_KEY, undefined);

  const openSourceEnv = loadTrialProviderDevEnvironment({
    JANUS_DISTRIBUTION_MODE: 'open-source',
    JANUS_DEV_TRIAL_PROVIDER_ENV_FILE: envPath,
  });
  assert.equal(openSourceEnv.JANUS_DISTRIBUTION_MODE, 'open-source');
  assert.equal(openSourceEnv.JANUS_DEV_TRIAL_PROVIDER, undefined);
  assert.equal(openSourceEnv.JANUS_TRIAL_CODEX_KEY, undefined);

  const developmentEnv = loadTrialProviderDevEnvironment({
    JANUS_DISTRIBUTION_MODE: 'open-source',
    JANUS_DEV_TRIAL_PROVIDER_ENV_FILE: envPath,
  });
  assert.equal(developmentEnv.JANUS_DEV_TRIAL_PROVIDER, '1');
  assert.equal(developmentEnv.JANUS_TRIAL_CODEX_KEY, apiKey);
  assert.equal(developmentEnv.JANUS_TRIAL_CODEX_BASE_URL, baseUrl);
  assert.equal(developmentEnv.JANUS_PROVIDER_KEY_DISTRIBUTION_KEY, undefined);
  assert.equal(developmentEnv.DATABASE_URL, undefined);
  const provider = loadDevelopmentTrialProvider(developmentEnv);
  assert.equal(provider.available, true);
  assert.equal(provider.apiKey, apiKey);
  assert.equal(provider.baseUrl, baseUrl);

  for (const name of trackedEnvNames) delete process.env[name];
  Object.assign(process.env, developmentEnv);
  const codexDir = path.join(runtimeRoot, 'config', 'codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'config.toml'), [
    'model_provider = "custom"',
    'model = "gpt-5.6-sol"',
    'review_model = "gpt-5.6-sol"',
    'model_reasoning_effort = "medium"',
    '',
    '[model_providers.custom]',
    'name = "custom"',
    'base_url = ""',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    'env_key = "OPENAI_API_KEY"',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(codexDir, 'auth.json'), '{\n  "OPENAI_API_KEY": ""\n}\n');
  const status = codexConfigStatus(runtimeRoot);
  assert.equal(status.credentialSource, 'development');
  assert.equal(status.baseUrl, baseUrl);
  assert.equal(status.hasApiKey, true);
  assert.equal(loadAuthEnv(runtimeRoot).OPENAI_API_KEY, apiKey);
  assert.equal(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8').includes(apiKey), false);
  fs.writeFileSync(path.join(codexDir, 'config.toml'), fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8').replace('base_url = ""', 'base_url = "https://stored-provider.example/v1"'));
  fs.writeFileSync(path.join(codexDir, 'auth.json'), '{\n  "OPENAI_API_KEY": "sk-stored-provider"\n}\n');
  const overriddenStatus = codexConfigStatus(runtimeRoot);
  assert.equal(overriddenStatus.credentialSource, 'development');
  assert.equal(overriddenStatus.baseUrl, baseUrl);
  assert.equal(loadAuthEnv(runtimeRoot).OPENAI_API_KEY, apiKey);
  setCodexStoredProviderValidation(runtimeRoot, true);
  const validatedStatus = codexConfigStatus(runtimeRoot);
  assert.equal(validatedStatus.credentialSource, 'stored');
  assert.equal(validatedStatus.baseUrl, 'https://stored-provider.example/v1');
  fs.writeFileSync(path.join(codexDir, 'auth.json'), '{\n  "OPENAI_API_KEY": "sk-modified-after-test"\n}\n');
  const invalidatedStatus = codexConfigStatus(runtimeRoot);
  assert.equal(invalidatedStatus.credentialSource, 'development');
  assert.equal(invalidatedStatus.userProviderOverrideValidated, false);
  process.stdout.write('Development trial Provider smoke passed.\n');
} finally {
  for (const name of trackedEnvNames) {
    if (priorEnv[name] === undefined) delete process.env[name];
    else process.env[name] = priorEnv[name];
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
