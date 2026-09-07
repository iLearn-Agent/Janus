import { spawnSync } from 'node:child_process';
import path from 'node:path';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const testFile = path.join(process.cwd(), 'scripts', 'electron_database_recovery_ui_e2e.mjs');
const command = ['win32', 'darwin'].includes(process.platform) ? process.execPath : 'xvfb-run';
const args = command === 'xvfb-run' ? ['-a', process.execPath, testFile] : [testFile];
const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
