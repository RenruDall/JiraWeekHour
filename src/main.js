'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, session, safeStorage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const core = require('./core');
const { handleSquirrelEvent } = require('./squirrel');
const { getAutostart, setAutostart } = require('./autostart');

const APP_NAME = 'Jira Week Hours';
const START_HIDDEN = process.argv.includes('--hidden');
const CAPTURE = (process.argv.find((a) => a.startsWith('--capture=')) || '').slice('--capture='.length); // dev: screenshot and quit

if (handleSquirrelEvent()) {
  // Started by the installer (install, update, uninstall): nothing else to do
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName(APP_NAME);
  if (process.platform === 'win32') app.setAppUserModelId('com.squirrel.JiraWeekHours.JiraWeekHours');
  app.on('second-instance', () => showMain());
  app.whenReady().then(start);
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
}

let mainWindow = null;
let loginWindow = null;
let tray = null;
let quitting = false;
let hiddenHintShown = false;
let demoBumps = 0;
const doneSlots = new Set();
const state = {
  report: null, error: null, updating: false, lastUpdate: null, lastReason: null,
  lastLogged: null, lastDate: null, sinceLast: null, settingsWarning: null,
};

// ---------------------------------------------------------------- settings
const dataDir = () => app.getPath('userData');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const tokenFile = () => path.join(dataDir(), 'token.bin');

function loadSettings() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { /* first run */ }
  try {
    state.settingsWarning = null;
    return core.normalizeSettings(raw);
  } catch (err) {
    state.settingsWarning = `Settings problem: ${err.message} Using defaults until fixed.`;
    return core.normalizeSettings({});
  }
}

function writeSettings(settings) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function saveToken(token) {
  if (!token) { fs.rmSync(tokenFile(), { force: true }); return; }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer cannot encrypt the token, so it was not saved.');
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(tokenFile(), safeStorage.encryptString(token));
}

function loadToken() {
  try { return safeStorage.decryptString(fs.readFileSync(tokenFile())); } catch { return null; }
}

// The Jira sign-in keeps its cookies here, separate from the app's own window
const jiraSession = () => session.fromPartition('persist:jira');

function makeFetcher(settings) {
  const headers = {};
  if (settings.auth === 'token') {
    const token = loadToken();
    if (!token) throw new core.JiraError('auth', 'No token saved yet. Open Settings and paste your API token.');
    // Jira Cloud API tokens go with the account e-mail (Basic); Data Center personal access tokens are Bearer tokens
    headers.Authorization = settings.email
      ? `Basic ${Buffer.from(`${settings.email}:${token}`).toString('base64')}`
      : `Bearer ${token}`;
  }
  const ses = jiraSession();
  try { ses.allowNTLMCredentialsForDomains(new URL(settings.baseUrl).hostname); } catch { /* not critical */ }
  return core.makeJsonFetcher((url, init) => ses.fetch(url, init), settings.baseUrl, headers);
}

// ------------------------------------------------------------------- update
async function refresh(reason) {
  if (state.updating) return;
  state.updating = true;
  pushState();
  const settings = loadSettings();
  try {
    let report;
    if (settings.demo) {
      if (reason === 'manual') demoBumps += 1;
      report = core.demoReport(new Date(), demoBumps, settings);
    } else if (!settings.baseUrl) {
      throw new core.JiraError('setup', 'No Jira connected yet.');
    } else {
      report = await core.loadReport(makeFetcher(settings), settings, new Date());
    }
    const todayKey = core.dateKey(new Date());
    const sameDay = state.lastDate === todayKey;
    state.sinceLast = sameDay && state.lastLogged !== null && report.today.logged !== state.lastLogged
      ? Math.round((report.today.logged - state.lastLogged) * 100) / 100 : null;
    state.lastLogged = report.today.logged;
    state.lastDate = todayKey;
    state.report = report;
    state.error = null;
    if (reason.startsWith('scheduled') && report.today.missing > 0) {
      notify('Jira hours', `${report.today.missing.toFixed(1)}h remaining today (${report.today.logged.toFixed(1)}h logged so far).`, 'info');
    }
  } catch (err) {
    state.error = { kind: err.kind || 'other', message: err.message || String(err) };
    if (state.error.kind === 'setup') state.report = null;
    if (reason !== 'startup' && state.error.kind !== 'setup') notify('Jira hours', `Update failed: ${state.error.message}`, 'warning');
  } finally {
    state.updating = false;
    state.lastUpdate = new Date().toISOString();
    state.lastReason = reason;
    pushState();
  }
}

function resetProgress() {
  demoBumps = 0;
  state.lastLogged = null;
  state.sinceLast = null;
  state.report = null;
}

function pushState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const settings = loadSettings();
  mainWindow.webContents.send('state', {
    settings,
    hasToken: !!loadToken(),
    autostart: getAutostart(),
    report: state.report,
    error: state.error,
    updating: state.updating,
    lastUpdate: state.lastUpdate,
    lastReason: state.lastReason,
    sinceLast: state.sinceLast,
    nextUpdate: core.nextUpdateText(settings.refreshTimes, new Date()),
    settingsWarning: state.settingsWarning,
    tray: core.trayInfo(state.report, state.error),
    platform: process.platform,
  });
}

// ----------------------------------------------------------- notifications
function notify(title, content, iconType) {
  if (tray && process.platform === 'win32') {
    tray.displayBalloon({ title, content, iconType, respectQuietTime: true });
  }
}

// ------------------------------------------------------------ fixed times
function dueSlot(settings) {
  const now = new Date();
  for (const time of settings.refreshTimes) {
    const [h, m] = time.split(':').map(Number);
    const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    const id = `${core.dateKey(now)} ${time}`;
    if (now >= slot && !doneSlots.has(id)) {
      doneSlots.add(id);
      return time;
    }
  }
  return null;
}

function tick() {
  const settings = loadSettings();
  const slot = dueSlot(settings);
  if (slot) refresh(`scheduled ${slot}`);
  else if (state.lastDate && state.lastDate !== core.dateKey(new Date())) refresh('new day');
  else pushState(); // keeps "next automatic update" current
}

// ------------------------------------------------------------------ windows
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 740,
    minWidth: 780,
    minHeight: 560,
    show: false,
    title: APP_NAME,
    backgroundColor: '#f6f5f2',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'ui', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (!START_HIDDEN || CAPTURE) mainWindow.show();
  });

  // Closing the window keeps the app running in the tray
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    if (!hiddenHintShown) {
      hiddenHintShown = true;
      notify(APP_NAME, 'Still running here. Click the icon to open it, right-click for more.', 'info');
    }
  });
}

function showMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openLogin() {
  const settings = loadSettings();
  if (!settings.baseUrl) return;
  if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.focus(); return; }
  loginWindow = new BrowserWindow({
    width: 1000,
    height: 780,
    title: 'Sign in to Jira',
    parent: mainWindow && mainWindow.isVisible() ? mainWindow : undefined,
    autoHideMenuBar: true,
    webPreferences: { partition: 'persist:jira', contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  loginWindow.setMenu(null);
  loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try { jiraSession().allowNTLMCredentialsForDomains(new URL(settings.baseUrl).hostname); } catch { /* ignore */ }

  // After each page load, check quietly whether the sign-in worked
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const current = loadSettings();
      const fetchJson = makeFetcher({ ...current, auth: 'browser' });
      const deployment = await core.detectDeployment(fetchJson, current.baseUrl);
      await fetchJson(`/rest/api/${deployment === 'cloud' ? 3 : 2}/myself`);
      if (current.auth !== 'browser') writeSettings({ ...current, auth: 'browser' });
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
      refresh('signed in');
    } catch { /* not signed in yet */ } finally {
      checking = false;
    }
  };
  loginWindow.webContents.on('did-finish-load', check);
  loginWindow.on('closed', () => { loginWindow = null; });
  loginWindow.loadURL(`${settings.baseUrl}/`).catch(() => { /* the window shows the error */ });
}

async function disconnect() {
  const settings = loadSettings();
  try { await jiraSession().clearStorageData(); } catch { /* ignore */ }
  saveToken(null);
  writeSettings({ ...settings, baseUrl: '', email: '', auth: 'browser', demo: false });
  resetProgress();
  refresh('disconnected');
}

// --------------------------------------------------------------------- tray
function buildTrayMenu() {
  const settings = loadSettings();
  return Menu.buildFromTemplate([
    { label: 'Open', click: showMain },
    { label: 'Update now', click: () => refresh('manual') },
    { type: 'separator' },
    ...(process.platform === 'win32'
      ? [{ label: 'Start with Windows', type: 'checkbox', checked: getAutostart(), click: (item) => { setAutostart(item.checked); pushState(); } }]
      : []),
    { label: 'Sign in to Jira…', enabled: !!settings.baseUrl && settings.auth === 'browser' && !settings.demo, click: openLogin },
    { label: 'Settings…', click: () => { showMain(); mainWindow.webContents.send('open-settings'); } },
    { label: 'Demo mode', type: 'checkbox', checked: settings.demo, click: (item) => { writeSettings({ ...settings, demo: item.checked }); resetProgress(); refresh('settings'); } },
    { type: 'separator' },
    { label: 'Exit', click: () => { quitting = true; app.quit(); } },
  ]);
}

function setTrayIcon(dataUrl, tooltip) {
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) return;
  if (!tray) {
    tray = new Tray(image);
    tray.on('click', showMain);
    tray.on('balloon-click', showMain);
  } else {
    tray.setImage(image);
  }
  tray.setToolTip(tooltip);
  tray.setContextMenu(buildTrayMenu());
}

// ---------------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.on('ready', () => pushState());
  ipcMain.on('refresh', () => refresh('manual'));
  ipcMain.on('sign-in', () => openLogin());
  ipcMain.on('disconnect', () => { disconnect(); });
  ipcMain.on('tray-icon', (_e, dataUrl, tooltip) => {
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')) setTrayIcon(dataUrl, String(tooltip || APP_NAME).slice(0, 120));
  });

  // First-run screen: save the address and open the sign-in window
  ipcMain.handle('connect', async (_e, address) => {
    try {
      const current = loadSettings();
      const next = core.normalizeSettings({ ...current, baseUrl: address, auth: 'browser', demo: false });
      if (!next.baseUrl) throw new Error('Please enter your Jira address.');
      writeSettings(next);
      resetProgress();
      openLogin();
      return { ok: true, baseUrl: next.baseUrl };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.handle('save-settings', async (_e, input) => {
    try {
      const current = loadSettings();
      const next = core.normalizeSettings({ ...current, ...input.settings });
      if (next.auth === 'token' && input.token) saveToken(String(input.token).trim());
      if (next.auth === 'token' && !next.demo && next.baseUrl && !loadToken()) throw new Error('Paste your API token, or choose "Sign in with Jira window".');
      writeSettings(next);
      if (typeof input.autostart === 'boolean') setAutostart(input.autostart);
      if (next.demo !== current.demo || next.baseUrl !== current.baseUrl) resetProgress();
      refresh('settings');
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.on('rendered', () => {
    if (!CAPTURE) return;
    setTimeout(async () => {
      const image = await mainWindow.webContents.capturePage();
      fs.writeFileSync(CAPTURE, image.toPNG());
      quitting = true;
      app.quit();
    }, 400);
  });
}

// -------------------------------------------------------------------- start
function start() {
  registerIpc();
  createMainWindow();

  const settings = loadSettings();
  while (dueSlot(settings)) { /* times already passed today don't fire now */ }

  refresh('startup');
  setInterval(tick, 30 * 1000);
  powerMonitor.on('resume', () => refresh('resume'));
}
