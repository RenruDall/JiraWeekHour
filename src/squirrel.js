'use strict';
// Handles the events the Windows installer (Squirrel) sends to the app on install, update
// and uninstall: create or remove the Start menu and desktop shortcuts, then quit.
// Same job as the electron-squirrel-startup package, without the extra dependency.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { setAutostart } = require('./autostart');

function runUpdateExe(args, done) {
  const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
  if (!fs.existsSync(updateExe)) { done(); return; }
  try {
    const child = spawn(updateExe, args, { detached: true });
    child.on('close', () => done());
    child.on('error', () => done());
  } catch {
    done();
  }
}

// Returns true when the app was started by the installer and must not open normally
function handleSquirrelEvent() {
  if (process.platform !== 'win32' || process.argv.length < 2) return false;
  const exeName = path.basename(process.execPath);
  switch (process.argv[1]) {
    case '--squirrel-install':
    case '--squirrel-updated':
      runUpdateExe(['--createShortcut', exeName], () => app.quit());
      return true;
    case '--squirrel-uninstall':
      try { setAutostart(false); } catch { /* ignore */ }
      runUpdateExe(['--removeShortcut', exeName], () => app.quit());
      return true;
    case '--squirrel-obsolete':
      app.quit();
      return true;
    default:
      return false;
  }
}

module.exports = { handleSquirrelEvent };
