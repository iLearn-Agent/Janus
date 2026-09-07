import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { codexThreadSupportsMetadataUpdates, isNonFatalCodexMemoryNoChanges, prepareCodexHome, setCodexThreadMemoryMode } from '../src/main/codex.js';
import { codexMemoryConfig, parseSimpleToml } from '../src/main/codexConfig.js';
import { classifyPrivacy, upsertTypedMemory } from '../src/main/memory.js';
import { codexMemoriesDir } from '../src/main/paths.js';
import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-codex-memory-'));
const runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });

try {
  const config = parseSimpleToml(codexMemoryConfig('[features]\nmulti_agent = true\n'));
  assert.equal(config.features.memories, true);
  assert.equal(config.memories.generate_memories, false);
  assert.equal(config.memories.use_memories, true);
  assert.equal(config.memories.disable_on_external_context, true);
  const retryDefaults = parseSimpleToml(codexMemoryConfig([
    'model_provider = "third_party"',
    '[model_providers.third_party]',
    'base_url = "https://provider.example/v1"',
    '',
  ].join('\n')));
  assert.equal(retryDefaults.model_providers.third_party.request_max_retries, 4);
  assert.equal(retryDefaults.model_providers.third_party.stream_max_retries, 5);
  const explicitRetryPolicy = parseSimpleToml(codexMemoryConfig([
    'model_provider = "third_party"',
    '[model_providers.third_party]',
    'request_max_retries = 0',
    'stream_max_retries = 2',
    '',
  ].join('\n')));
  assert.equal(explicitRetryPolicy.model_providers.third_party.request_max_retries, 0);
  assert.equal(explicitRetryPolicy.model_providers.third_party.stream_max_retries, 2);

  const firstHome = path.join(root, 'codex-home-a');
  const secondHome = path.join(root, 'codex-home-b');
  await prepareCodexHome(root, firstHome, { useMemories: false, generateMemories: false });
  await prepareCodexHome(root, secondHome, { useMemories: true, generateMemories: true });
  assert.equal(await fs.promises.realpath(path.join(firstHome, 'memories')), await fs.promises.realpath(codexMemoriesDir(root)));
  assert.equal(await fs.promises.realpath(path.join(secondHome, 'memories')), await fs.promises.realpath(codexMemoriesDir(root)));
  const firstConfig = parseSimpleToml(fs.readFileSync(path.join(firstHome, 'config.toml'), 'utf8'));
  assert.equal(firstConfig.memories.use_memories, false);
  assert.equal(firstConfig.memories.generate_memories, false);
  assert.equal(firstConfig.model_providers.custom.request_max_retries, 4);
  assert.equal(firstConfig.model_providers.custom.stream_max_retries, 5);
  const secondConfig = parseSimpleToml(fs.readFileSync(path.join(secondHome, 'config.toml'), 'utf8'));
  assert.equal(secondConfig.memories.generate_memories, true);
  const requests = [];
  await setCodexThreadMemoryMode(async (method, params) => requests.push({ method, params }), 'thread-memory-test', false);
  assert.deepEqual(requests, [{
    method: 'thread/memoryMode/set',
    params: { threadId: 'thread-memory-test', mode: 'disabled' },
  }]);
  assert.equal(codexThreadSupportsMetadataUpdates({ ephemeral: true }), false);
  assert.equal(codexThreadSupportsMetadataUpdates({ ephemeral: false }), true);
  assert.equal(isNonFatalCodexMemoryNoChanges({
    code: 1,
    stderr: '2026-07-19T06:47:37.584819Z ERROR codex_memories_write::phase2: Phase 2\nno changes',
    answer: '正常回答',
  }), true);
  assert.equal(isNonFatalCodexMemoryNoChanges({
    code: 1,
    stderr: '2026-07-19T06:47:37.584819Z ERROR codex_memories_write::phase2: Phase 2\nno changes',
    answer: '',
  }), false);
  assert.equal(isNonFatalCodexMemoryNoChanges({
    code: 1,
    stderr: 'ERROR provider: authentication failed',
    answer: '不应掩盖真正错误',
  }), false);
  const marker = path.join(codexMemoriesDir(root), 'shared-marker.txt');
  fs.writeFileSync(marker, 'shared native memory state');
  fs.rmSync(firstHome, { recursive: true, force: true });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'shared native memory state');

  let session = runtime.store.createSession({
    title: 'Memory controls',
    memoryUseEnabled: false,
    memoryGenerateEnabled: true,
  });
  assert.equal(session.memoryUseEnabled, false);
  assert.equal(session.memoryGenerateEnabled, true);
  session = runtime.store.updateSession(session.id, { memoryUseEnabled: true, memoryGenerateEnabled: false });
  assert.equal(session.memoryUseEnabled, true);
  assert.equal(session.memoryGenerateEnabled, false);

  assert.equal(classifyPrivacy('api_key = sk-example-secret-value-12345', 'stable_learning'), 'blocked_private');
  const blocked = upsertTypedMemory(runtime.db, {
    ownerId: 'general_agent',
    memoryType: 'stable_learning',
    content: 'Authorization: Bearer private-token-value-12345',
  });
  assert.equal(blocked.status, 'blocked_private');
  assert.equal(Object.hasOwn(blocked, 'content'), false);
  const policy = upsertTypedMemory(runtime.db, {
    ownerId: 'general_agent',
    memoryType: 'do_not_store',
    content: 'Never retain collaborator Alice private project notes.',
  });
  const policyRow = runtime.db.prepare('SELECT content, status, privacy_level FROM typed_memories WHERE id = ?').get(policy.id);
  assert.match(policyRow.content, /^\[REDACTED privacy_policy; sha256:/);
  assert.equal(policyRow.status, 'blocked');
  assert.equal(policyRow.privacy_level, 'privacy_policy');

  const agentsGuidance = fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf8');
  assert.match(agentsGuidance, /credentials, private project data, unpublished material/);
  console.log('Codex memory harness smoke passed.');
} finally {
  runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
}
