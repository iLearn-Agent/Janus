import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  createEvolutionModelExecutor,
  evolutionModelDelegatedToWorker,
  evolutionModelProviderStatus,
} from '../src/modules/evolution/modelProvider.mjs';
import { evolutionCapabilities } from '../src/modules/evolution/index.mjs';

test('Evolution Worker securely loads a Responses provider from an explicit Codex home', async (t) => {
  const home = await codexHome(t);
  const requests = [];
  const executor = createEvolutionModelExecutor({
    env: { JANUS_EVOLUTION_CODEX_HOME: home },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response({ output_text: '{"decision":"pass"}' });
    },
  });
  assert.equal(executor.available, true);
  assert.deepEqual(executor.providerStatus(), {
    available: true,
    source: 'codex_home',
    code: 'ok',
    model: 'evolution-primary',
    reviewModel: 'evolution-review',
  });
  assert.equal(await executor({ prompt: 'Return JSON.', modelRole: 'hr_review' }), '{"decision":"pass"}');
  assert.equal(requests[0].url, 'https://provider.example/v1/responses');
  assert.equal(requests[0].options.headers.authorization, 'Bearer server-secret-key');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    model: 'evolution-review', input: 'Return JSON.', store: false, reasoning: { effort: 'high' },
  });
  assert.equal(JSON.stringify(executor.providerStatus()).includes('server-secret-key'), false);
  assert.equal(JSON.stringify(executor.providerStatus()).includes(home), false);
});

test('Evolution Worker refuses a group-readable Codex auth file', async (t) => {
  const home = await codexHome(t);
  await fsPromises.chmod(path.join(home, 'auth.json'), 0o640);
  assert.deepEqual(evolutionModelProviderStatus({ env: { JANUS_EVOLUTION_CODEX_HOME: home } }), {
    available: false,
    source: 'codex_home',
    code: 'evolution_codex_auth_permissions_insecure',
    model: '',
    reviewModel: '',
  });
});

test('Evolution provider errors redact the API key', async (t) => {
  const home = await codexHome(t);
  const executor = createEvolutionModelExecutor({
    env: { JANUS_EVOLUTION_CODEX_HOME: home },
    fetchImpl: async () => response({ error: { message: 'Rejected server-secret-key and Bearer server-secret-key' } }, 401),
  });
  await assert.rejects(() => executor({ prompt: 'Return JSON.' }), (error) => {
    assert.equal(error.code, 'evolution_model_failed');
    assert.equal(error.message.includes('server-secret-key'), false);
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
});

test('Explicit provider variables remain supported without reading Codex files', async () => {
  const executor = createEvolutionModelExecutor({
    env: {
      JANUS_EVOLUTION_PROVIDER_BASE_URL: 'https://provider.example',
      JANUS_EVOLUTION_PROVIDER_API_KEY: 'environment-secret',
      JANUS_EVOLUTION_MODEL: 'environment-model',
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://provider.example/v1/responses');
      assert.equal(options.headers.authorization, 'Bearer environment-secret');
      return response({ output_text: 'ok' });
    },
  });
  assert.equal(await executor({ prompt: 'health' }), 'ok');
  assert.equal(executor.providerStatus().source, 'environment');
});

test('Evolution provider retries transient transport failures without exposing credentials', async () => {
  let attempts = 0;
  const executor = createEvolutionModelExecutor({
    env: {
      JANUS_EVOLUTION_PROVIDER_BASE_URL: 'https://provider.example',
      JANUS_EVOLUTION_PROVIDER_API_KEY: 'retry-secret',
      JANUS_EVOLUTION_MODEL: 'environment-model',
      JANUS_EVOLUTION_MODEL_MAX_ATTEMPTS: '3',
    },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('fetch failed');
      return response({ output_text: 'recovered' });
    },
  });
  assert.equal(await executor({ prompt: 'health' }), 'recovered');
  assert.equal(attempts, 3);
});

test('Cloud API may advertise delegated Worker readiness without loading its credential', () => {
  const env = {
    JANUS_EVOLUTION_MODEL_DELEGATED_TO_WORKER: 'true',
    JANUS_EVOLUTION_ALLOW_PLAINTEXT_TEST_ONLY: '1',
  };
  assert.equal(evolutionModelDelegatedToWorker(env), true);
  assert.equal(evolutionModelProviderStatus({ env }).available, false);
  assert.equal(evolutionCapabilities(env).personal.readiness.model, true);
  assert.equal(evolutionCapabilities(env).personal.executionAvailable, true);
});

async function codexHome(t) {
  const home = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'janus-evolution-codex-'));
  t.after(() => fsPromises.rm(home, { recursive: true, force: true }));
  await fsPromises.writeFile(path.join(home, 'config.toml'), `model_provider = "custom"
model = "evolution-primary"
review_model = "evolution-review"
model_reasoning_effort = "high"

[model_providers.custom]
base_url = "https://provider.example/v1"
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENAI_API_KEY"
`);
  await fsPromises.writeFile(path.join(home, 'auth.json'), '{"OPENAI_API_KEY":"server-secret-key"}\n');
  await fsPromises.chmod(home, 0o700);
  await fsPromises.chmod(path.join(home, 'config.toml'), 0o600);
  await fsPromises.chmod(path.join(home, 'auth.json'), 0o600);
  return home;
}

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}
