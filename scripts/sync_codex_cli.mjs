import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(projectRoot, 'package.json');
const args = new Set(process.argv.slice(2));
const mode = args.has('--sync') ? 'sync' : 'check';

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const currentVersion = normalizeVersion(packageJson.dependencies?.['@openai/codex']);
const requestedVersion = argumentValue('--version');
const latestVersion = requestedVersion || await fetchLatestCodexVersion();

if (currentVersion === latestVersion) {
  console.log(`Bundled Codex CLI is current (${currentVersion}).`);
  process.exit(0);
}

if (mode === 'check') {
  console.error(`Bundled Codex CLI ${currentVersion || '(missing)'} is behind ${latestVersion}. Run npm run sync:codex-cli.`);
  process.exit(1);
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, [
  'install',
  '--package-lock-only',
  '--ignore-scripts',
  '--save-exact',
  '--no-audit',
  '--no-fund',
  `@openai/codex@${latestVersion}`,
], {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log(`Bundled Codex CLI manifest updated from ${currentVersion || '(missing)'} to ${latestVersion}.`);

function argumentValue(name) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  if (index === -1) return '';
  const value = normalizeVersion(argv[index + 1]);
  if (!value) throw new Error(`${name} requires a semantic version.`);
  return value;
}

function normalizeVersion(value = '') {
  const normalized = String(value || '').trim().replace(/^[~^=v\s]+/, '');
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : '';
}

async function fetchLatestCodexVersion() {
  const registry = String(process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org/').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${registry}/${encodeURIComponent('@openai/codex')}/latest`, {
      headers: { accept: 'application/json', 'user-agent': 'Janus-Codex-CLI-Sync' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Codex CLI registry check failed with HTTP ${response.status}.`);
    const payload = await response.json();
    const version = normalizeVersion(payload.version);
    if (!version) throw new Error('Codex CLI registry returned an invalid version.');
    return version;
  } finally {
    clearTimeout(timer);
  }
}
