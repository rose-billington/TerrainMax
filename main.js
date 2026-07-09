const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1923',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('save-glb', async (_event, arrayBuffer) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export terrain',
    defaultPath: 'terrain.glb',
    filters: [{ name: 'GLTF Binary', extensions: ['glb'] }],
  });
  if (canceled || !filePath) return { ok: false };
  try {
    fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
