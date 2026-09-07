import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const preloadSource = read('src/preload/preload.js');
const ipcSource = read('src/main/ipc/registerIpcHandlers.js');
const preloadChannels = new Set(matches(preloadSource, /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g));
const handledChannels = new Set(matches(ipcSource, /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g));

assert.ok(preloadChannels.size > 50, 'preload IPC contract inventory is unexpectedly small');
for (const channel of preloadChannels) {
  assert.ok(handledChannels.has(channel), `preload invokes an unregistered IPC channel: ${channel}`);
}

const runtime = await import('../src/main/runtime.js');
const auth = await import('../src/main/auth.js');
const evolution = await import('../src/main/evolution.js');
const sqliteCloud = await import('../src/cloud/server.js');
const postgresCloud = await import('../cloud/src/server.mjs');

for (const [moduleName, module, names] of [
  ['runtime', runtime, ['createRuntime', 'pptOverallPercent', 'withWorkspaceBoundary']],
  ['auth', auth, ['AuthService', 'permissionsForRole']],
  ['evolution', evolution, ['EvolutionEngine', 'validateHrReviewProposal']],
  ['sqlite cloud', sqliteCloud, ['cloudHomeFromEnv', 'createCloudServer', 'initCloudHome', 'openCloudDatabase']],
  ['postgres cloud', postgresCloud, ['createApp', 'permissionsForRole']],
]) {
  for (const name of names) assert.ok(name in module, `${moduleName} compatibility export is missing: ${name}`);
}

console.log('contracts check passed');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function matches(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}
