'use strict';
// "Start with Windows". When installed with the Setup.exe (Squirrel), the app lives in a
// versioned folder that changes on every update, so autostart goes through Squirrel's
// Update.exe, which always starts the current version.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

function loginItemOptions() {
  const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
  if (fs.existsSync(updateExe)) {
    const exeName = path.basename(process.execPath);
    return { path: updateExe, args: ['--processStart', `"${exeName}"`, '--process-start-args', '"--hidden"'] };
  }
  return { path: process.execPath, args: ['--hidden'] };
}

function getAutostart() {
  if (process.platform !== 'win32') return false;
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
}

function setAutostart(enabled) {
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: !!enabled, ...loginItemOptions() });
}

module.exports = { getAutostart, setAutostart };
