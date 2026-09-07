import { spawnSync } from 'node:child_process';
import path from 'node:path';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.platform === 'linux') Object.assign(env, { TMPDIR: '/tmp', TEMP: '/tmp', TMP: '/tmp' });

const electronBinary = process.platform === 'win32' ? 'electron.exe' : 'electron';
const electron = path.join(process.cwd(), 'node_modules', 'electron', 'dist', electronBinary);
const smoke = path.join(process.cwd(), 'scripts', 'renderer_language_switch_smoke.cjs');
const command = process.platform === 'linux' ? 'xvfb-run' : electron;
const args = process.platform === 'linux'
  ? ['-a', electron, '--no-sandbox', '--disable-gpu', smoke]
  : ['--disable-gpu', smoke];
const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
