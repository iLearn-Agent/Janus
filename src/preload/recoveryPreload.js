import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('janusRecovery', {
  status: () => ipcRenderer.invoke('recovery:get-status'),
  scan: () => ipcRenderer.invoke('recovery:scan'),
  createBackup: () => ipcRenderer.invoke('recovery:create-backup'),
  repair: () => ipcRenderer.invoke('recovery:repair'),
  listBackups: () => ipcRenderer.invoke('recovery:list-backups'),
  listQuarantines: () => ipcRenderer.invoke('recovery:list-quarantines'),
  restore: (backupId) => ipcRenderer.invoke('recovery:restore', { backupId }),
  startFresh: () => ipcRenderer.invoke('recovery:start-fresh'),
  restoreQuarantine: (quarantineId) => ipcRenderer.invoke('recovery:restore-quarantine', { quarantineId }),
  exportDiagnostics: () => ipcRenderer.invoke('recovery:export-diagnostics'),
  openDataDirectory: () => ipcRenderer.invoke('recovery:open-data-directory'),
  restart: () => ipcRenderer.invoke('recovery:restart'),
  quit: () => ipcRenderer.invoke('recovery:quit'),
  setLanguage: (language) => ipcRenderer.invoke('recovery:set-language', { language }),
  onProgress: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, payload) => listener(payload || {});
    ipcRenderer.on('recovery:progress', handler);
    return () => ipcRenderer.removeListener('recovery:progress', handler);
  },
});
