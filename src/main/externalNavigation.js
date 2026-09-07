export function normalizeExternalHttpUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) && url.hostname ? url.href : '';
  } catch {
    return '';
  }
}

export function installExternalNavigation(window, { shell, onError = () => {} } = {}) {
  const webContents = window?.webContents;
  if (!webContents?.setWindowOpenHandler || !webContents?.on) return false;

  const openExternal = (value) => {
    const url = normalizeExternalHttpUrl(value);
    if (!url || typeof shell?.openExternal !== 'function') return false;
    Promise.resolve(shell.openExternal(url)).catch((error) => onError(error, url));
    return true;
  };

  webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (String(url || '') === String(webContents.getURL?.() || '')) return;
    event.preventDefault();
    openExternal(url);
  });
  return true;
}
