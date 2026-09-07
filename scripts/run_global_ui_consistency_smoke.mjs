import { spawnSync } from 'node:child_process';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.platform === 'linux') Object.assign(env, { TMPDIR: '/tmp', TEMP: '/tmp', TMP: '/tmp' });

const script = 'scripts/global_ui_consistency_smoke.mjs';
const command = process.platform === 'linux' ? 'xvfb-run' : process.execPath;
const args = process.platform === 'linux' ? ['-a', process.execPath, script] : [script];
const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
