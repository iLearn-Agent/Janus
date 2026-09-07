#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const separator = process.argv.indexOf('--');
const args = separator === -1 ? process.argv.slice(2) : process.argv.slice(separator + 1);
if (!args.length) throw new Error('Usage: npm run build:open-source -- npm run <pack-or-dist-script>');

const [requestedCommand, ...commandArgs] = args;
const command = process.platform === 'win32' && requestedCommand === 'npm' ? 'npm.cmd' : requestedCommand;
const env = { ...process.env, JANUS_DISTRIBUTION_MODE: 'open-source' };
for (const name of [
  'JANUS_TRIAL_CODEX_KEY',
  'JANUS_TRIAL_CODEX_KEY_FILE',
  'JANUS_TRIAL_CODEX_BASE_URL',
  'JANUS_TRIAL_PROVIDER_REQUIRED',
  'JANUS_ALLOW_OFFICIAL_PROVIDER_EMBED',
]) delete env[name];

const result = spawnSync(command, commandArgs, {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
  windowsHide: true,
  shell: false,
});
if (result.error) throw result.error;
process.exitCode = Number(result.status || 0);
