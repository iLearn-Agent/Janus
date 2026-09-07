import { spawnSync } from 'node:child_process';
import path from 'node:path';
import electronPath from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const smoke = path.join(process.cwd(), 'scripts', 'recovery_renderer_smoke.cjs');
const command = ['win32', 'darwin'].includes(process.platform) ? electronPath : 'xvfb-run';
const args = command === electronPath ? [smoke] : ['-a', electronPath, '--no-sandbox', smoke];
const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
