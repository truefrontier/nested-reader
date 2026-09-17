const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nestedDesktop', Object.freeze({
  revealLibrary: () => ipcRenderer.invoke('nested:reveal-library')
}));
