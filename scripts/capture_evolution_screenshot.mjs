import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const port = Number(process.env.JANUS_CAPTURE_PORT || 9333);
const electronBinary = process.platform === 'win32' ? 'electron.exe' : 'electron';
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', electronBinary);
const outputPath = path.join(root, 'workspace', 'demo-evolution-screenshot.png');

if (!existsSync(electronExe)) {
  throw new Error(`Electron executable not found: ${electronExe}`);
}

mkdirSync(path.dirname(outputPath), { recursive: true });

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const appProcess = spawn(electronExe, [`--remote-debugging-port=${port}`, '.'], {
  cwd: root,
  env: childEnv,
  stdio: 'ignore',
  windowsHide: false,
});

try {
  const target = await waitForPageTarget(port, 15000);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { width: 1440, height: 1100, windowState: 'normal' },
    });
    await sleep(600);
  } catch {
    // Some Electron builds do not expose Browser window bounds over CDP.
  }
  await cdp.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        let attempts = 0;
        const tick = () => {
          const button = document.querySelector('[data-tab="evolution"]');
          if (button) {
            button.click();
            resolve('clicked evolution');
            return;
          }
          attempts += 1;
          if (attempts > 120) {
            resolve('evolution tab not found');
            return;
          }
          setTimeout(tick, 100);
        };
        tick();
      })
    `,
    awaitPromise: true,
  });
  await cdp.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        let attempts = 0;
        const tick = () => {
          if (document.querySelector('.evolution-view')) {
            resolve('evolution view ready');
            return;
          }
          attempts += 1;
          if (attempts > 120) {
            resolve('evolution view timeout');
            return;
          }
          setTimeout(tick, 100);
        };
        tick();
      })
    `,
    awaitPromise: true,
  });
  await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        document.documentElement.style.scrollBehavior = 'auto';
        window.scrollTo(0, 0);
        const view = document.querySelector('.evolution-view');
        const head = document.querySelector('.evolution-simple-head');
        if (head) head.scrollIntoView({ block: 'start', inline: 'nearest' });
        if (view) view.scrollTop = 0;
      })()
    `,
  });
  const metrics = await cdp.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        let attempts = 0;
        const tick = () => {
          const head = document.querySelector('.evolution-simple-head');
          const h1 = document.querySelector('.evolution-page-title h1');
          const metrics = document.querySelector('.evolution-simple-metrics');
          const ready = head && h1 && metrics && document.querySelectorAll('.evolution-record-row').length > 0;
          if (ready || attempts > 80) {
            const view = document.querySelector('.evolution-view');
            if (head) head.scrollIntoView({ block: 'start', inline: 'nearest' });
            if (view) view.scrollTop = 0;
            window.scrollTo(0, 0);
            const viewRect = view ? view.getBoundingClientRect() : { top: 0 };
            const headRect = head ? head.getBoundingClientRect() : { top: 0, height: 0 };
            resolve({
              headHeight: head ? head.getBoundingClientRect().height : 0,
              h1Text: h1 ? h1.textContent : '',
              metricsHeight: metrics ? metrics.getBoundingClientRect().height : 0,
              viewScrollTop: view ? view.scrollTop : -1,
              viewTop: viewRect.top,
              headTop: headRect.top,
            });
            return;
          }
          attempts += 1;
          setTimeout(tick, 100);
        };
        tick();
      })
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log(JSON.stringify(metrics.result?.value || {}, null, 2));
  await sleep(900);
  const screenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  writeFileSync(outputPath, Buffer.from(screenshot.data, 'base64'));
  console.log(outputPath);
  await cdp.close();
} finally {
  appProcess.kill();
}

async function waitForPageTarget(debugPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for DevTools page target${lastError ? `: ${lastError.message}` : ''}`);
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.id || !pending.has(payload.id)) return;
    const { resolve, reject } = pending.get(payload.id);
    pending.delete(payload.id);
    if (payload.error) reject(new Error(payload.error.message || JSON.stringify(payload.error)));
    else resolve(payload.result || {});
  });

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed to open')), { once: true });
  });

  return opened.then(() => ({
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      const promise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      socket.send(JSON.stringify({ id, method, params }));
      return promise;
    },
    close() {
      socket.close();
    },
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
