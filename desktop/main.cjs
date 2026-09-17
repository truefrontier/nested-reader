const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// Portable storage: development and verification never write outside this project.
// Distributed builds keep their data beside the .app unless NESTED_DATA_DIR is set.
const root = path.resolve(__dirname, '..');
const dataRoot = path.resolve(process.env.NESTED_DATA_DIR || (app.isPackaged
  ? path.join(path.dirname(path.dirname(path.dirname(process.execPath))), '..', 'Nested Data')
  : path.join(root, '.local', 'desktop')));
fs.mkdirSync(path.join(dataRoot, 'profile'), { recursive: true });
app.setPath('userData', path.join(dataRoot, 'profile'));
app.setPath('sessionData', path.join(dataRoot, 'profile'));
app.setPath('crashDumps', path.join(dataRoot, 'crashes'));
app.setAppLogsPath(path.join(dataRoot, 'logs'));
let runtime, window;
const safeExternal = value => { try { const url = new URL(value); return url.protocol === 'https:'; } catch { return false; } };
function validSender(event) {
  return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
    new URL(event.senderFrame.url).origin === runtime.url;
}
async function createWindow() {
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 390, minHeight: 620,
    title: 'Nested', backgroundColor: '#fbfafc', show: !process.env.NESTED_SMOKE,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: true } });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(({url}) => {
    if (safeExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== runtime.url) { event.preventDefault(); if (safeExternal(url)) void shell.openExternal(url); }
  });
  window.webContents.session.on('will-download', (_event, item) => {
    // Native save dialog; default location also remains within portable storage.
    const exportsDir = path.join(dataRoot, 'exports'); fs.mkdirSync(exportsDir, { recursive: true });
    item.setSaveDialogOptions({ defaultPath: path.join(exportsDir, path.basename(item.getFilename())) });
  });
  await window.loadURL(`${runtime.url}/app`);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    const { startServer } = await import(pathToFileURL(path.join(root, 'server', 'index.mjs')).href);
    runtime = await startServer({ port: 0, dataDir: path.join(dataRoot, 'books'), desktop: true });
    ipcMain.handle('nested:reveal-library', async event => {
      if (!validSender(event)) throw new Error('Untrusted desktop request.');
      const error = await shell.openPath(runtime.store.root); if(error) throw new Error(error);
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Nested', submenu: [{role:'about'}, {type:'separator'}, {role:'hide'}, {role:'hideOthers'}, {role:'unhide'}, {type:'separator'}, {role:'quit'}] },
      { label: 'Edit', submenu: [{role:'undo'}, {role:'redo'}, {type:'separator'}, {role:'cut'}, {role:'copy'}, {role:'paste'}, {role:'selectAll'}] },
      { label: 'View', submenu: [{role:'reload'}, {role:'resetZoom'}, {role:'zoomIn'}, {role:'zoomOut'}, {role:'togglefullscreen'}] },
      { label: 'Window', submenu: [{role:'minimize'}, {role:'zoom'}, {role:'front'}] }
    ]));
    if (process.env.NESTED_SMOKE === '1') {
      // Service and package checks only; no GUI browser is created for this test.
      const response = await fetch(`${runtime.url}/api/bootstrap`); const info = await response.json();
      const reader = await fetch(`${runtime.url}/app`);
      if (info.model !== 'gpt-6-astra' || !info.desktop || !info.books.length || !reader.ok)
        throw new Error('Packaged service smoke check failed.');
      console.log('NESTED_DESKTOP_SMOKE_OK ' + JSON.stringify({model:info.model,books:info.books.length,readerStatus:reader.status}));
      app.quit();
    } else await createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) void createWindow(); });
  }).catch(error => {
    console.error('Nested startup failed:', error.message);
    if (!process.env.NESTED_SMOKE) dialog.showErrorBox('Nested could not start', error.message);
    app.exit(1);
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { runtime?.server.close(); runtime?.server.closeAllConnections(); });
}
