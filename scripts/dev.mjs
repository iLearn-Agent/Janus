import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';
import { loadTrialProviderDevEnvironment } from './lib/trialProviderDevEnv.mjs';

const rawArgs = process.argv.slice(2);
const internalProvider = rawArgs.includes('--internal-provider');
const openSourceProvider = rawArgs.includes('--open-source-provider');
const args = rawArgs.filter((arg) => !['--internal-provider', '--open-source-provider'].includes(arg));
const isLinux = process.platform === 'linux';

function xDisplayIsReachable(environment) {
  if (!environment.DISPLAY) return false;
  const probe = spawnSync('xdpyinfo', [], {
    env: environment,
    stdio: 'ignore',
    timeout: 3_000,
  });
  if (probe.error?.code === 'ENOENT') return true;
  return probe.status === 0;
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    const forwardSignal = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    const cleanup = () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      process.off('SIGHUP', onSighup);
    };
    const onSigint = () => forwardSignal('SIGINT');
    const onSigterm = () => forwardSignal('SIGTERM');
    const onSighup = () => forwardSignal('SIGHUP');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    process.once('SIGHUP', onSighup);
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve({ code: code ?? (signal ? 1 : 0), signal });
    });
  });
}

async function launchElectron(childEnv) {
  const sqliteWarningOption = '--disable-warning=ExperimentalWarning';
  const nodeOptions = childEnv.NODE_OPTIONS?.includes(sqliteWarningOption)
    ? childEnv.NODE_OPTIONS
    : [childEnv.NODE_OPTIONS, sqliteWarningOption].filter(Boolean).join(' ');
  const electronArgs = isLinux
    ? [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-gpu-compositing',
        '--disable-features=Vulkan,UseSkiaRenderer',
        '.',
        ...args,
      ]
    : ['.', ...args];
  const child = spawn(electronPath, electronArgs, {
    cwd: process.cwd(),
    env: { ...childEnv, NODE_OPTIONS: nodeOptions },
    stdio: 'inherit',
    windowsHide: false,
  });
  return waitForChild(child);
}

async function main() {
  // Load local, gitignored development settings before constructing the
  // Electron child environment. Existing shell variables take precedence.
  const localEnvPath = path.resolve(process.cwd(), '.env');
  try {
    const localEnv = fs.readFileSync(localEnvPath, 'utf8');
    for (const line of localEnv.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const developmentEnv = loadTrialProviderDevEnvironment({
    ...process.env,
    ...(openSourceProvider ? { JANUS_DISTRIBUTION_MODE: 'open-source' } : {}),
    ...(internalProvider ? { JANUS_DEV_TRIAL_PROVIDER: '1', JANUS_DISTRIBUTION_MODE: 'open-source' } : {}),
  });
  if (isLinux && !developmentEnv.DBUS_SESSION_BUS_ADDRESS && developmentEnv.JANUS_DBUS_WRAPPED !== '1') {
    const child = spawn(
      'dbus-run-session',
      ['--', process.execPath, fileURLToPath(import.meta.url), ...args],
      {
        cwd: process.cwd(),
        env: { ...developmentEnv, JANUS_DBUS_WRAPPED: '1' },
        stdio: 'inherit',
        windowsHide: false,
      },
    );
    return waitForChild(child);
  }

  if (isLinux && developmentEnv.DISPLAY && developmentEnv.JANUS_XVFB_WRAPPED !== '1'
    && !xDisplayIsReachable(developmentEnv)) {
    throw new Error(
      `Cannot connect to X server at DISPLAY=${developmentEnv.DISPLAY}. `
      + 'For a visible window, enable X11 forwarding (for example, ssh -Y) and restart from that SSH session. '
      + 'For headless startup, unset DISPLAY so the launcher can use xvfb-run.',
    );
  }

  if (isLinux && !developmentEnv.DISPLAY && developmentEnv.JANUS_XVFB_WRAPPED !== '1') {
    const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' });
    if (xvfb.status !== 0) {
      throw new Error('Linux development requires a graphical DISPLAY or xvfb-run. Install xvfb for headless startup.');
    }
    console.warn(
      '[Janus] No graphical DISPLAY detected. Starting under Xvfb in headless mode; no desktop window will appear. '
      + 'To see the UI over SSH, enable X11 forwarding and verify that $DISPLAY is set before running npm run dev.',
    );
    const child = spawn(
      'xvfb-run',
      ['-a', process.execPath, fileURLToPath(import.meta.url), ...args],
      {
        cwd: process.cwd(),
        env: { ...developmentEnv, JANUS_XVFB_WRAPPED: '1' },
        stdio: 'inherit',
        windowsHide: false,
      },
    );
    return waitForChild(child);
  }

  if (isLinux && developmentEnv.DISPLAY) {
    console.log(`[Janus] Launching the desktop window on DISPLAY=${developmentEnv.DISPLAY}.`);
  }

  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = developmentEnv;
  if (!isLinux) return launchElectron(env);

  const linuxEnv = {
    ...env,
    ELECTRON_DISABLE_SANDBOX: '1',
    LIBGL_ALWAYS_SOFTWARE: env.LIBGL_ALWAYS_SOFTWARE || '1',
    GTK_IM_MODULE: env.GTK_IM_MODULE || 'ibus',
    QT_IM_MODULE: env.QT_IM_MODULE || 'ibus',
    XMODIFIERS: env.XMODIFIERS || '@im=ibus',
  };
  return launchElectron(linuxEnv);
}

try {
  const result = await main();
  if (result?.signal) console.error(`Electron exited from signal ${result.signal}.`);
  process.exitCode = Number(result?.code || 0);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
