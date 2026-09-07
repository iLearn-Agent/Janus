const guardedStreams = new WeakSet();

export function installBrokenPipeGuards({ stdout = process.stdout, stderr = process.stderr } = {}) {
  for (const stream of [stdout, stderr]) {
    if (!stream || typeof stream.on !== 'function' || guardedStreams.has(stream)) continue;
    guardedStreams.add(stream);
    stream.on('error', () => {
      // A packaged GUI can outlive the NSIS process that launched it. Once that
      // parent closes its inherited pipes, console output is non-essential and
      // must never terminate the Electron main process.
    });
  }
}

export function sendWebContentsSafely(window, channel, payload) {
  if (!window || window.isDestroyed?.()) return false;
  const webContents = window.webContents;
  if (!webContents || webContents.isDestroyed?.()) return false;
  try {
    webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}
