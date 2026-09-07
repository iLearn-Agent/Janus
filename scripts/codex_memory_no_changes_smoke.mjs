import { strict as assert } from 'node:assert';
import { chmodSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCodexSession } from '../src/main/codex.js';
import { writeCodexTemplates } from '../src/main/codexConfig.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-memory-no-changes-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-memory-no-changes-bin-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const fakeCodexCmd = path.join(binRoot, 'fake-codex.cmd');
const configCapture = path.join(binRoot, 'session-config.toml');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousCapture = process.env.JANUS_MEMORY_CONFIG_CAPTURE;

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) process.exit(0);
const outputIndex = args.indexOf('--output-last-message');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : '';
if (outputPath) fs.writeFileSync(outputPath, '多模态推荐正常回答', 'utf8');
const configPath = path.join(process.env.CODEX_HOME || '', 'config.toml');
if (configPath && process.env.JANUS_MEMORY_CONFIG_CAPTURE) {
  fs.copyFileSync(configPath, process.env.JANUS_MEMORY_CONFIG_CAPTURE);
}
process.stderr.write('2026-07-19T06:47:37.584819Z ERROR codex_memories_write::phase2: Phase 2\\nno changes\\n');
process.exit(1);
`);
chmodSync(fakeCodex, 0o755);
await writeFile(fakeCodexCmd, `@echo off\r\n"${process.execPath}" "${fakeCodex}" %*\r\n`);

try {
  process.env.JANUS_CODEX_BIN = process.platform === 'win32' ? fakeCodexCmd : fakeCodex;
  process.env.JANUS_MEMORY_CONFIG_CAPTURE = configCapture;
  writeCodexTemplates(root);
  const result = await runCodexSession({
    root,
    cwd: root,
    sessionId: 'memory-no-changes-session',
    prompt: '请给出多模态推荐。',
    memoryUseEnabled: true,
    memoryGenerateEnabled: false,
  });
  assert.equal(result.answer, '多模态推荐正常回答');
  const sessionConfig = await readFile(configCapture, 'utf8');
  assert.match(sessionConfig, /\[memories\][\s\S]*generate_memories = false/);
  console.log('Codex memory no-changes smoke passed.');
} finally {
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousCapture === undefined) delete process.env.JANUS_MEMORY_CONFIG_CAPTURE;
  else process.env.JANUS_MEMORY_CONFIG_CAPTURE = previousCapture;
  await rm(root, { recursive: true, force: true });
  await rm(binRoot, { recursive: true, force: true });
}
