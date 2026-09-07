import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = process.cwd();
const smokeHome = mkdtempSync(path.join(os.tmpdir(), 'janus-contact-profile-switch-'));
const port = Number(process.env.JANUS_CONTACT_PROFILE_SWITCH_PORT || 9473);
const electronBinary = process.platform === 'win32' ? 'electron.exe' : 'electron';
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', electronBinary);
const childEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: '1',
  JANUS_LOCAL_EVOLUTION_ENABLED: '0',
  JANUS_MODEL_REFRESH_ENABLED: '0',
  JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
  JANUS_HOME: smokeHome,
  JANUS_AUTH_URL: '',
};
delete childEnv.ELECTRON_RUN_AS_NODE;

const seedRuntime = await createRuntime({ root: smokeHome, isDev: true });
seedRuntime.authRegister({
  email: 'rapid-contact-switch@example.com', password: 'rapid-contact-password', displayName: 'Rapid Contact Tester',
});
seedRuntime.close();
const electronArgs = ['--no-sandbox', `--user-data-dir=${path.join(smokeHome, 'profile')}`, `--remote-debugging-port=${port}`, '.'];
const command = process.platform === 'linux' && !process.env.DISPLAY ? 'xvfb-run' : electronExe;
const args = command === electronExe ? electronArgs : ['-a', electronExe, ...electronArgs];
const child = spawn(command, args, {
  cwd: root,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  const target = await waitForPageTarget(port, 15_000);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1876, height: 1161, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('[data-network-view="friends"]')`);
  await evaluate(cdp, `document.querySelector('[data-network-view="friends"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.contacts-workspace')`);
  await evaluate(cdp, `(async () => {
    const { state } = await import('./app/state.js');
    const people = ['a', 'b', 'c'].map((suffix, index) => ({
      id: 'rapid_contact_' + suffix,
      displayName: '快速联系人' + (index + 1),
      username: 'rapid-' + suffix,
      email: 'rapid-' + suffix + '@example.com',
    }));
    state.friendOverview = {
      friends: people.map((friend) => ({ id: 'relationship_' + friend.id, status: 'accepted', friend })),
      requests: { incoming: [], outgoing: [] },
      organizations: [],
    };
    state.friendDirectoryCategory = 'external';
    state.friendDirectoryView = 'contacts';
    state.contactsActivePane = 'contacts';
    document.querySelector('[data-friend-directory-category="external"]')?.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelectorAll('[data-contact-profile^="rapid_contact_"]').length === 3`);
  await evaluate(cdp, `window.__rapidContactTargets = []; document.addEventListener('click', (event) => {
    window.__rapidContactTargets.push(event.target?.closest?.('[data-contact-profile]')?.dataset?.contactProfile || event.target?.tagName || '');
  }, true)`);

  await physicalClick(cdp, 'rapid_contact_a');
  await delay(280);
  for (const id of ['rapid_contact_b', 'rapid_contact_c', 'rapid_contact_a']) {
    await physicalClick(cdp, id);
    await delay(35);
  }
  await delay(280);
  const debouncedContactId = await evaluate(cdp, `(async () => {
    const { state } = await import('./app/state.js');
    return state.networkSelectedContactId;
  })()`);

  await physicalClick(cdp, 'rapid_contact_b');
  await delay(235);
  const animationSample = await evaluate(cdp, `(() => {
    const drawer = document.querySelector('.contact-profile-drawer');
    const content = document.querySelector('.contact-profile-body:not(.is-contact-profile-outgoing)');
    const drawerStyle = drawer ? getComputedStyle(drawer) : null;
    return {
      drawerOpacity: drawerStyle?.opacity || '',
      drawerTransform: drawerStyle?.transform || '',
      contentAnimationCount: content?.getAnimations?.().length || 0,
      outgoingCount: drawer?.querySelectorAll('.is-contact-profile-outgoing').length || 0,
    };
  })()`);
  await delay(300);

  const result = await evaluate(cdp, `(async () => {
    const { state } = await import('./app/state.js');
    return {
      profileOpen: state.networkContactProfileOpen,
      selectedContactId: state.networkSelectedContactId,
      drawerContactId: document.querySelector('[data-contact-profile-id]')?.dataset?.contactProfileId || '',
      drawerCount: document.querySelectorAll('.contact-profile-drawer').length,
      drawerWidth: document.querySelector('.contact-profile-drawer')?.getBoundingClientRect().width || 0,
      descriptionFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.contact-profile-body > p')).fontSize),
      actionFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.contact-profile-actions button')).fontSize),
      actionWhiteSpace: getComputedStyle(document.querySelector('.contact-profile-actions button')).whiteSpace,
      language: document.documentElement.dataset.language || '',
      hitTargets: window.__rapidContactTargets,
      pageTransitionActive: document.documentElement.classList.contains('is-contact-profile-transition'),
      debouncedContactId: ${JSON.stringify(debouncedContactId)},
      animationSample: ${JSON.stringify(animationSample)},
    };
  })()`);
  const expectedTargets = ['rapid_contact_a', 'rapid_contact_b', 'rapid_contact_c', 'rapid_contact_a', 'rapid_contact_b'];
  const expectedActionWhiteSpace = result.language === 'en' ? 'normal' : 'nowrap';
  if (!result.profileOpen || result.selectedContactId !== 'rapid_contact_b' || result.drawerContactId !== 'rapid_contact_b'
    || result.drawerCount !== 1 || result.drawerWidth < 460 || result.descriptionFontSize < 15
    || result.actionFontSize < 14 || result.actionWhiteSpace !== expectedActionWhiteSpace
    || result.pageTransitionActive || result.hitTargets.join(',') !== expectedTargets.join(',')
    || result.debouncedContactId !== 'rapid_contact_a'
    || result.animationSample.drawerOpacity !== '1' || result.animationSample.drawerTransform !== 'none'
    || result.animationSample.contentAnimationCount < 1 || result.animationSample.outgoingCount !== 1) {
    throw new Error(`Rapid contact profile switching is unstable: ${JSON.stringify(result)}`);
  }
  console.log('contact profile rapid switch smoke passed');
  cdp.close();
} catch (error) {
  throw new Error(`${error.message}\nElectron stderr:\n${stderr.slice(-4000)}`);
} finally {
  signalProcessTree(child, 'SIGTERM');
  await delay(500);
  signalProcessTree(child, 'SIGKILL');
  try { rmSync(smokeHome, { recursive: true, force: true }); } catch {}
}

function signalProcessTree(handle, signal) {
  if (!handle?.pid) return;
  try {
    if (process.platform === 'win32') {
      if (handle.exitCode === null) handle.kill(signal);
    } else {
      process.kill(-handle.pid, signal);
    }
  } catch {}
}

async function physicalClick(cdp, contactId) {
  const point = await evaluate(cdp, `(() => {
    const rect = document.querySelector('[data-contact-profile="${contactId}"]')?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`);
  if (!point) throw new Error(`Contact row is missing: ${contactId}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

async function waitForRenderer(cdp, expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(${expression})`)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for renderer expression: ${expression}`);
}

async function waitForPageTarget(debugPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch {}
    await delay(200);
  }
  throw new Error('Timed out waiting for Electron renderer.');
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.id || !pending.has(payload.id)) return;
    const request = pending.get(payload.id);
    pending.delete(payload.id);
    if (payload.error) request.reject(new Error(payload.error.message || 'CDP request failed'));
    else request.resolve(payload.result || {});
  });
  return new Promise((resolve) => socket.addEventListener('open', () => resolve({
    send(method, params = {}) {
      const id = nextId++;
      const response = new Promise((requestResolve, requestReject) => pending.set(id, { resolve: requestResolve, reject: requestReject }));
      socket.send(JSON.stringify({ id, method, params }));
      return response;
    },
    close() { socket.close(); },
  })));
}
