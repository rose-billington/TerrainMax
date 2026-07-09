const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveGlb: (arrayBuffer) => ipcRenderer.invoke('save-glb', arrayBuffer),
});
