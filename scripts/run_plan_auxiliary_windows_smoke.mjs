import { spawn } from 'node:child_process';
import path from 'node:path';

const electron = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const child = spawn(electron, [path.join(process.cwd(), 'scripts', 'plan_auxiliary_windows_smoke.cjs')], {
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
