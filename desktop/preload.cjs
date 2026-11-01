// Sandboxed Electron preload requires CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron');

// Expose fixed operations; never expose ipcRenderer, arbitrary paths or generic invoke.
contextBridge.exposeInMainWorld('envGuardDesktop', {
  getSettings: () => ipcRenderer.invoke('envguardcc:desktop-settings:get'),
  updateSettings: settings => ipcRenderer.invoke('envguardcc:desktop-settings:update', settings),
  resetClaude: () => ipcRenderer.invoke('envguardcc:claude-reset'),
});
