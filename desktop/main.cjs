const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// Persist under Electron userData (macOS Application Support) or a project-local
// folder in development. Never mkdir beside the .app — App Translocation makes
// that path read-only when Nested is launched from Downloads.
const root = path.resolve(__dirname, '..');
const dataRoot = process.env.NESTED_DATA_DIR
  ? path.resolve(process.env.NESTED_DATA_DIR)
  : (app.isPackaged
      ? app.getPath('userData')
      : path.join(root, '.local', 'desktop'));
if (!app.isPackaged || process.env.NESTED_DATA_DIR) {
  fs.mkdirSync(path.join(dataRoot, 'profile'), { recursive: true });
  app.setPath('userData', path.join(dataRoot, 'profile'));
  app.setPath('sessionData', path.join(dataRoot, 'profile'));
  app.setPath('crashDumps', path.join(dataRoot, 'crashes'));
  app.setAppLogsPath(path.join(dataRoot, 'logs'));
} else {
  fs.mkdirSync(path.join(dataRoot, 'books'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'exports'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'logs'), { recursive: true });
}
