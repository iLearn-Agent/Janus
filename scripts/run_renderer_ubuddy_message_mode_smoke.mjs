import { spawnSync } from 'node:child_process';
import path from 'node:path';

import electronPath from 'electron';

const smoke = path.join(process.cwd(), 'scripts', 'renderer_ubuddy_message_mode_smoke.cjs');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const virtual = !['win32', 'darwin'].includes(process.platform);
const command = virtual ? 'xvfb-run' : electronPath;
const args = virtual ? ['-a', electronPath, '--no-sandbox', smoke] : [smoke];
const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
