import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['--test', 'cloud/test/auth-friends.test.mjs'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code || 0);
});
