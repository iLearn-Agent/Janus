import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const mainSource = readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const startupSource = readFileSync(new URL('../src/renderer/startup.html', import.meta.url), 'utf8');

assert.ok(mainSource.indexOf('createStartupWindow();') < mainSource.indexOf('runtime = await createRuntime({'),
  'the branded startup window must appear before Runtime initialization');
assert.match(mainSource, /desktop-startup-runtime-ready/);
assert.match(mainSource, /did-finish-load[\s\S]*closeStartupWindow/);
assert.match(indexSource, /janus-startup-shell/);
assert.match(indexSource, /优先载入本地工作区/);
assert.match(startupSource, /window\.setStartupStage/);
assert.match(rendererSource, /bootstrap\(\{ remote: false \}\)/);
assert.match(rendererSource, /completeStartupBackgroundRefresh/);
assert.match(rendererSource, /bootstrap\(\{ remote: true, preloadMessages: false \}\)/);

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-progressive-bootstrap-'));
let runtime = null;
try {
  runtime = await createRuntime({ root, isDev: true });
  const user = runtime.auth.createVerifiedUser({
    email: 'startup@example.com', password: 'startup-password1', displayName: 'Startup User', emailVerified: 1,
  });
  runtime.auth.setActiveUser(user.id);
  let evolutionRefreshCount = 0;
  let employeeRefreshCount = 0;
  runtime.cloudSync.refreshEvolutionCapabilities = async () => {
    evolutionRefreshCount += 1;
    return runtime.cloudSync.cachedEvolutionCapabilities();
  };
  runtime.cloudSync.employeeOverview = async () => {
    employeeRefreshCount += 1;
    return {};
  };
  const preloadedSession = runtime.store.createSession({
    userId: user.id,
    title: 'Startup preload conversation',
    departmentId: 'general',
  });
  runtime.store.addMessage({
    sessionId: preloadedSession.id,
    role: 'assistant',
    content: 'STARTUP_PRELOAD_VISIBLE',
    departmentId: 'general',
  });

  const localBoot = await runtime.bootstrap({ remote: false });
  assert.equal(localBoot.currentUser.id, user.id);
  assert.equal(evolutionRefreshCount, 0, 'local-first bootstrap must not wait for cloud evolution capabilities');
  assert.equal(employeeRefreshCount, 0, 'local-first bootstrap must not wait for the cloud employee overview');
  assert.equal(localBoot.messagePreload?.version, 'startup_message_preload_v1');
  assert.equal(localBoot.messagePreload?.sessionPages?.[preloadedSession.id]?.items?.at(-1)?.content, 'STARTUP_PRELOAD_VISIBLE',
    'local bootstrap must carry a ready-to-render message page for each visible session');

  const remoteBoot = await runtime.bootstrap({ remote: true, preloadMessages: false });
  assert.equal(evolutionRefreshCount, 1);
  assert.equal(employeeRefreshCount, 1);
  assert.equal(remoteBoot.messagePreload, null, 'background remote refresh may skip the already-loaded message cache');

  console.log('startup progressive bootstrap smoke passed');
} finally {
  await Promise.resolve(runtime?.close?.()).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
