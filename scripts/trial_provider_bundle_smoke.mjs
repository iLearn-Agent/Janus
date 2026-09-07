#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  codexConfigFiles,
  codexConfigStatus,
  codexConfigTextForRuntime,
  codexStoredProviderCandidate,
  loadAuthEnv,
  saveCodexConfig,
  saveCodexConfigFiles,
  setCodexStoredProviderValidation,
} from '../src/main/codexConfig.js';
import { prepareCodexHome } from '../src/main/codex.js';
import { createCodexRuntimeApi } from '../src/main/modules/codex/index.js';
import { configureEmbeddedTrialProviderPath, loadEmbeddedTrialProvider } from '../src/main/trialProvider.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-trial-provider-'));
const bundlePath = path.join(tempRoot, 'provider.enc');
const runtimeRoot = path.join(tempRoot, 'runtime');
const apiKey = 'janus_internal_trial_provider_smoke_secret';
const baseUrl = 'https://trial-provider.example/v1';
const require = createRequire(import.meta.url);

try {
  const result = spawnSync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'prepare_trial_provider_bundle.mjs'),
    '--root', process.cwd(),
    '--output', bundlePath,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      JANUS_DISTRIBUTION_MODE: 'open-source',
      JANUS_TRIAL_CODEX_KEY: apiKey,
      JANUS_TRIAL_CODEX_BASE_URL: baseUrl,
      JANUS_TRIAL_PROVIDER_REQUIRED: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const serialized = fs.readFileSync(bundlePath, 'utf8');
  assert.equal(serialized.includes(apiKey), false, 'bundle must not contain the plaintext API Key');
  assert.equal(serialized.includes(baseUrl), false, 'bundle must not contain the plaintext Provider URL');

  const embedded = loadEmbeddedTrialProvider({ bundlePath, fresh: true });
  assert.equal(embedded.available, true);
  assert.equal(embedded.apiKey, apiKey);
  assert.equal(embedded.baseUrl, baseUrl);

  configureEmbeddedTrialProviderPath(bundlePath);
  const blankRuntimeRoot = path.join(tempRoot, 'blank-runtime');
  const blankFiles = codexConfigFiles(blankRuntimeRoot);
  assert.equal(blankFiles.configToml, '');
  assert.equal(blankFiles.authJson, '');
  const blankStatus = codexConfigStatus(blankRuntimeRoot);
  assert.equal(blankStatus.credentialSource, 'embedded');
  assert.equal(loadAuthEnv(blankRuntimeRoot).OPENAI_API_KEY, apiKey);
  assert.equal(fs.readFileSync(blankFiles.authPath, 'utf8').includes(apiKey), false);
  const codexConfigDir = path.join(runtimeRoot, 'config', 'codex');
  fs.mkdirSync(codexConfigDir, { recursive: true });
  fs.writeFileSync(path.join(codexConfigDir, 'config.toml'), [
    'model_provider = "legacy"',
    'model = "gpt-5.6-sol"',
    'review_model = "gpt-5.6-sol"',
    'model_reasoning_effort = "medium"',
    '',
    '[model_providers.legacy]',
    'name = "legacy"',
    'base_url = "https://discarded-provider.example/v1"',
    'wire_api = "chat"',
    'requires_openai_auth = true',
    'env_key = "LEGACY_KEY"',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(codexConfigDir, 'auth.json'), '{\n  "LEGACY_KEY": "sk-discarded-local-key"\n}\n');
  const status = codexConfigStatus(runtimeRoot);
  assert.equal(status.credentialSource, 'embedded');
  assert.equal(status.configurationMode, 'embedded-with-user-override');
  assert.equal(status.adminProviderOverrideEnabled, false);
  assert.equal(status.storedHasApiKey, true);
  assert.equal(status.storedBaseUrl, 'https://discarded-provider.example/v1');
  assert.equal(status.baseUrl, baseUrl);
  assert.equal(status.hasApiKey, true);
  const managedAuthEnv = loadAuthEnv(runtimeRoot);
  assert.equal(managedAuthEnv.OPENAI_API_KEY, apiKey);
  assert.equal(managedAuthEnv.LEGACY_KEY, undefined, 'managed mode must not pass stale local credentials to Codex');
  const managedRuntimeConfig = codexConfigTextForRuntime(runtimeRoot);
  assert.match(managedRuntimeConfig, /model_provider = "custom"/);
  assert.match(managedRuntimeConfig, /\[model_providers\.custom\]/);
  assert.match(managedRuntimeConfig, /wire_api = "responses"/);
  assert.match(managedRuntimeConfig, /env_key = "OPENAI_API_KEY"/);
  const authFile = fs.readFileSync(status.authPath, 'utf8');
  assert.equal(authFile.includes(apiKey), false, 'embedded API Key must not be written to auth.json');
  const managedCodexHome = path.join(tempRoot, 'managed-codex-home');
  await prepareCodexHome(runtimeRoot, managedCodexHome, { useMemories: false, generateMemories: false });
  const managedSessionAuth = fs.readFileSync(path.join(managedCodexHome, 'auth.json'), 'utf8');
  assert.equal(managedSessionAuth, '{}\n', 'managed Codex homes must not copy stale local auth.json credentials');
  assert.equal(managedSessionAuth.includes('sk-discarded-local-key'), false);

  saveCodexConfig(runtimeRoot, {
    baseUrl: 'https://admin-provider.example/v1',
    apiKey: 'sk-admin-override',
    model: 'gpt-admin',
    reasoningEffort: 'high',
  });
  const unvalidatedAdminStatus = codexConfigStatus(runtimeRoot);
  assert.equal(unvalidatedAdminStatus.credentialSource, 'embedded');
  setCodexStoredProviderValidation(runtimeRoot, true);
  const adminStatus = codexConfigStatus(runtimeRoot);
  assert.equal(adminStatus.credentialSource, 'stored');
  assert.equal(adminStatus.adminProviderOverrideEnabled, true);
  assert.equal(adminStatus.baseUrl, 'https://admin-provider.example/v1');
  assert.equal(loadAuthEnv(runtimeRoot).OPENAI_API_KEY, 'sk-admin-override');

  saveCodexConfig(runtimeRoot, {
    baseUrl: 'https://admin-provider.example/v1',
    model: 'gpt-admin',
    reasoningEffort: 'high',
    adminProviderOverride: false,
  });
  const managedStatus = codexConfigStatus(runtimeRoot);
  assert.equal(managedStatus.credentialSource, 'embedded');
  assert.equal(managedStatus.adminProviderOverrideEnabled, false);
  assert.equal(loadAuthEnv(runtimeRoot).OPENAI_API_KEY, apiKey);
  configureEmbeddedTrialProviderPath('');
  const compatibilityFallback = codexConfigStatus(runtimeRoot);
  assert.equal(compatibilityFallback.credentialSource, 'stored');
  assert.equal(loadAuthEnv(runtimeRoot).OPENAI_API_KEY, 'sk-admin-override');
  configureEmbeddedTrialProviderPath(bundlePath);

  const tampered = JSON.parse(serialized);
  tampered.tag = Buffer.alloc(16).toString('base64');
  const tamperedPath = path.join(tempRoot, 'tampered.enc');
  fs.writeFileSync(tamperedPath, JSON.stringify(tampered));
  const invalid = loadEmbeddedTrialProvider({ bundlePath: tamperedPath, fresh: true });
  assert.equal(invalid.available, false);
  assert.equal(invalid.source, 'invalid');

  const envFile = path.join(tempRoot, 'trial-provider.env');
  const envBundlePath = path.join(tempRoot, 'provider-from-env.enc');
  fs.writeFileSync(envFile, [
    `JANUS_TRIAL_CODEX_KEY=${apiKey}`,
    `JANUS_TRIAL_CODEX_BASE_URL=${baseUrl}`,
    'JANUS_TRIAL_PROVIDER_REQUIRED=1',
    '',
  ].join('\n'));
  const envOnly = {
    ...process.env,
    JANUS_DISTRIBUTION_MODE: 'open-source',
    JANUS_TRIAL_PROVIDER_ENV_FILE: envFile,
  };
  for (const name of ['JANUS_TRIAL_CODEX_KEY', 'JANUS_TRIAL_CODEX_KEY_FILE', 'JANUS_TRIAL_CODEX_BASE_URL', 'JANUS_TRIAL_PROVIDER_REQUIRED']) {
    delete envOnly[name];
  }
  const envResult = spawnSync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'prepare_trial_provider_bundle.mjs'),
    '--root', process.cwd(),
    '--output', envBundlePath,
  ], { cwd: process.cwd(), env: envOnly, encoding: 'utf8' });
  assert.equal(envResult.status, 0, envResult.stderr || envResult.stdout);
  assert.equal(loadEmbeddedTrialProvider({ bundlePath: envBundlePath, fresh: true }).available, true);

  const openSourceBundlePath = path.join(tempRoot, 'provider-open-source.enc');
  const openSourceEnv = {
    ...process.env,
    JANUS_DISTRIBUTION_MODE: 'open-source',
    JANUS_TRIAL_CODEX_KEY: 'sk-poisoned-build-environment',
    JANUS_TRIAL_CODEX_BASE_URL: 'https://api.openai.com/v1',
  };
  for (const name of ['JANUS_TRIAL_CODEX_KEY_FILE', 'JANUS_TRIAL_PROVIDER_REQUIRED']) delete openSourceEnv[name];
  const openSourceResult = spawnSync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'prepare_trial_provider_bundle.mjs'),
    '--root', process.cwd(),
    '--output', openSourceBundlePath,
  ], { cwd: process.cwd(), env: openSourceEnv, encoding: 'utf8' });
  assert.equal(openSourceResult.status, 0, openSourceResult.stderr || openSourceResult.stdout);
  const openSourceProvider = loadEmbeddedTrialProvider({ bundlePath: openSourceBundlePath, fresh: true });
  assert.equal(openSourceProvider.available, false);
  assert.equal(openSourceProvider.distributionMode, 'open-source');
  configureEmbeddedTrialProviderPath(openSourceBundlePath);
  const openSourceStatus = codexConfigStatus(runtimeRoot);
  assert.equal(openSourceStatus.configurationMode, 'user-configurable');
  assert.equal(openSourceStatus.credentialSource, 'stored');

  const memberAuth = {
    requireUser: () => ({ id: 'member', role: 'member', email: 'member@example.com', emailVerified: true }),
    requireAdmin: () => { throw new Error('需要管理员权限。'); },
  };
  let userProviderProbePass = true;
  let userProviderProbeModel = '';
  let userProviderProbeModelVerified = false;
  const runtimeApi = createCodexRuntimeApi({
    auth: memberAuth,
    runtimeRoot,
    runDoctor: async () => ({}),
    configStatus: codexConfigStatus,
    configFiles: codexConfigFiles,
    saveConfig: saveCodexConfig,
    saveConfigFiles: saveCodexConfigFiles,
    storedProviderCandidate: codexStoredProviderCandidate,
    setStoredProviderValidation: setCodexStoredProviderValidation,
    probeProvider: async ({ model = '' } = {}) => {
      userProviderProbeModel = model;
      return userProviderProbePass
        ? ({
          status: 'pass',
          summary: 'ok',
          modelIds: [userProviderProbeModelVerified ? 'different-catalog-id' : 'gpt-user'],
          modelVerified: userProviderProbeModelVerified,
        })
        : ({ status: 'fail', summary: 'invalid key', modelIds: [] });
    },
  });
  assert.ok(runtimeApi.codexConfigFiles().configToml.includes('model_provider'));
  configureEmbeddedTrialProviderPath(bundlePath);
  const userConfigToml = [
    'model_provider = "user"',
    'model = "gpt-user"',
    'review_model = "gpt-user"',
    'model_reasoning_effort = "medium"',
    '',
    '[model_providers.user]',
    'name = "user"',
    'base_url = "https://user-provider.example/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    'env_key = "USER_PROVIDER_KEY"',
    '',
  ].join('\n');
  const validatedUserConfig = await runtimeApi.saveCodexConfigFiles({
    configToml: userConfigToml,
    authJson: '{\n  "USER_PROVIDER_KEY": "user-provider-key"\n}\n',
  });
  assert.equal(validatedUserConfig.test.passed, true);
  assert.equal(userProviderProbeModel, 'gpt-user');
  assert.equal(validatedUserConfig.status.credentialSource, 'stored');
  assert.equal(loadAuthEnv(runtimeRoot).USER_PROVIDER_KEY, 'user-provider-key');
  userProviderProbeModelVerified = true;
  const routeVerifiedUserConfig = await runtimeApi.saveCodexConfigFiles({
    configToml: userConfigToml,
    authJson: '{\n  "USER_PROVIDER_KEY": "user-provider-key"\n}\n',
  });
  assert.equal(routeVerifiedUserConfig.test.passed, true,
    'a successful model route must take precedence over an incomplete /models catalog');
  fs.writeFileSync(path.join(codexConfigDir, 'auth.json'), '{\n  "USER_PROVIDER_KEY": "changed-without-test"\n}\n');
  assert.equal(codexConfigStatus(runtimeRoot).credentialSource, 'embedded');
  assert.equal(loadAuthEnv(runtimeRoot).OPENAI_API_KEY, apiKey);
  const clearedUserConfig = await runtimeApi.saveCodexConfigFiles({ configToml: '', authJson: '' });
  assert.equal(clearedUserConfig.test.status, 'fallback');
  assert.equal(clearedUserConfig.status.credentialSource, 'embedded');
  assert.equal(fs.readFileSync(path.join(codexConfigDir, 'config.toml'), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(codexConfigDir, 'auth.json'), 'utf8'), '');
  userProviderProbePass = false;
  const failedUserConfig = await runtimeApi.saveCodexConfigFiles({
    configToml: userConfigToml,
    authJson: '{\n  "USER_PROVIDER_KEY": "invalid-user-provider-key"\n}\n',
  });
  assert.equal(failedUserConfig.test.passed, false);
  assert.equal(failedUserConfig.status.credentialSource, 'embedded');
  assert.match(failedUserConfig.files.authJson, /invalid-user-provider-key/);
  assert.equal(loadAuthEnv(runtimeRoot).OPENAI_API_KEY, apiKey);
  assert.throws(() => runtimeApi.requestProviderKeyApplication({ organization: 'Member Lab' }), /当前未开放/);
  await assert.rejects(() => runtimeApi.claimProviderKeyApplication({ applicationId: 'provider-key-application-smoke' }), /当前未开放/);

  const unsafeEnv = {
    ...process.env,
    JANUS_DISTRIBUTION_MODE: 'open-source',
    JANUS_TRIAL_CODEX_KEY: 'sk-proj-official-looking-key',
    JANUS_TRIAL_CODEX_BASE_URL: 'https://api.openai.com/v1',
    JANUS_TRIAL_PROVIDER_REQUIRED: '1',
    JANUS_TRIAL_PROVIDER_ENV_FILE: path.join(tempRoot, 'missing-provider.env'),
  };
  delete unsafeEnv.JANUS_ALLOW_OFFICIAL_PROVIDER_EMBED;
  const unsafeResult = spawnSync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'prepare_trial_provider_bundle.mjs'),
    '--root', process.cwd(),
    '--output', path.join(tempRoot, 'unsafe-provider.enc'),
  ], {
    cwd: process.cwd(),
    env: unsafeEnv,
    encoding: 'utf8',
  });
  assert.notEqual(unsafeResult.status, 0);
  assert.match(`${unsafeResult.stderr}\n${unsafeResult.stdout}`, /Refusing to embed/);

  const acknowledgedOfficialBundlePath = path.join(tempRoot, 'acknowledged-official-provider.enc');
  const acknowledgedOfficialResult = spawnSync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'prepare_trial_provider_bundle.mjs'),
    '--root', process.cwd(),
    '--output', acknowledgedOfficialBundlePath,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      JANUS_DISTRIBUTION_MODE: 'open-source',
      JANUS_TRIAL_CODEX_KEY: 'sk-proj-acknowledged-official-key',
      JANUS_TRIAL_CODEX_BASE_URL: 'https://api.openai.com/v1',
      JANUS_TRIAL_PROVIDER_REQUIRED: '1',
      JANUS_ALLOW_OFFICIAL_PROVIDER_EMBED: 'I_UNDERSTAND_THIS_KEY_CAN_BE_EXTRACTED',
    },
    encoding: 'utf8',
  });
  assert.equal(acknowledgedOfficialResult.status, 0, acknowledgedOfficialResult.stderr || acknowledgedOfficialResult.stdout);
  assert.match(acknowledgedOfficialResult.stderr, /can be extracted/);
  const acknowledgedOfficialProvider = loadEmbeddedTrialProvider({ bundlePath: acknowledgedOfficialBundlePath, fresh: true });
  assert.equal(acknowledgedOfficialProvider.available, true);
  assert.equal(acknowledgedOfficialProvider.baseUrl, 'https://api.openai.com/v1');

  const applyTestReleaseIdentity = require('../deploy/electron-builder.test-identity.cjs');
  let requiredDuringBeforePack = 'not-called';
  const priorRequired = process.env.JANUS_TRIAL_PROVIDER_REQUIRED;
  delete process.env.JANUS_TRIAL_PROVIDER_REQUIRED;
  const testBuild = applyTestReleaseIdentity({
    beforePack: async () => { requiredDuringBeforePack = process.env.JANUS_TRIAL_PROVIDER_REQUIRED || ''; },
  }, { output: 'test-artifacts/smoke', artifactName: 'smoke.${ext}' });
  await testBuild.beforePack({});
  assert.equal(requiredDuringBeforePack, '');
  assert.equal(process.env.JANUS_TRIAL_PROVIDER_REQUIRED, undefined);
  if (priorRequired !== undefined) process.env.JANUS_TRIAL_PROVIDER_REQUIRED = priorRequired;

  const priorMode = process.env.JANUS_DISTRIBUTION_MODE;
  process.env.JANUS_DISTRIBUTION_MODE = 'open-source';
  requiredDuringBeforePack = 'not-called';
  const internalTestBuild = applyTestReleaseIdentity({
    beforePack: async () => { requiredDuringBeforePack = process.env.JANUS_TRIAL_PROVIDER_REQUIRED || ''; },
  }, { output: 'test-artifacts/internal-smoke', artifactName: 'smoke.${ext}' });
  await internalTestBuild.beforePack({});
  assert.equal(requiredDuringBeforePack, '1');
  if (priorMode === undefined) delete process.env.JANUS_DISTRIBUTION_MODE;
  else process.env.JANUS_DISTRIBUTION_MODE = priorMode;

  process.stdout.write('Trial Provider bundle smoke passed.\n');
} finally {
  configureEmbeddedTrialProviderPath('');
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
