'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, session, safeStorage, powerMonitor, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const core = require('./core');
const { handleSquirrelEvent } = require('./squirrel');
const { getAutostart, setAutostart } = require('./autostart');
const { readPolicy } = require('./policy');

const APP_NAME = 'Jira Week Hours';
const START_HIDDEN = process.argv.includes('--hidden');
const FIRST_RUN = process.argv.includes('--squirrel-firstrun'); // first start right after installing
const APP_STARTED = new Date();
const BOOT_TIME = new Date(Date.now() - os.uptime() * 1000);
const argValue = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const CAPTURE = argValue('capture');           // dev: screenshot the window and quit
const CAPTURE_VIEW = argValue('capture-view'); // dev: open this view first (week, calendar, log)
const CAPTURE_PDF = argValue('capture-pdf');   // dev: write the PDF report here and quit

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
  ctx: null, // who we are and which Jira; reused for every week and month
  policy: {}, // settings fixed by IT in the registry
  members: null, // team members, cached per session
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
    return core.normalizeSettings({ ...raw, ...state.policy });
  } catch (err) {
    state.settingsWarning = `Settings problem: ${err.message} Using defaults until fixed.`;
    return core.normalizeSettings({ ...state.policy });
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

// --------------------------------------------------------------- work clock
// Kept only on this PC (%APPDATA%\Jira Week Hours\clock.json); never sent to Jira.
const clockFile = () => path.join(dataDir(), 'clock.json');
let clock = null;
let lastClockDay = null;

function loadClock() {
  if (clock) return clock;
  try { clock = JSON.parse(fs.readFileSync(clockFile(), 'utf8')); } catch { clock = {}; }
  if (!clock || typeof clock !== 'object' || !clock.days) clock = { days: {} };
  return clock;
}

function saveClock() {
  const days = Object.keys(clock.days).sort();
  for (const key of days.slice(0, Math.max(0, days.length - 60))) delete clock.days[key]; // keep 60 days
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(clockFile(), JSON.stringify(clock, null, 1));
  } catch { /* not critical */ }
}

function clockDay(date = new Date()) {
  const key = core.dateKey(date);
  const days = loadClock().days;
  if (!days[key]) days[key] = { appStart: null, firstActive: null, manual: null, pauses: [] };
  return days[key];
}

function markAppStart() {
  const day = clockDay();
  if (!day.appStart || new Date(day.appStart) > APP_STARTED) day.appStart = APP_STARTED.toISOString();
  saveClock();
}

function markActive(now = new Date()) {
  const day = clockDay(now);
  if (!day.firstActive) { day.firstActive = now.toISOString(); saveClock(); }
}

function openPause(kind) {
  const now = new Date();
  const day = clockDay(now);
  const open = day.pauses.find((p) => !p.to);
  if (!open) { day.pauses.push({ from: now.toISOString(), to: null, kind }); saveClock(); }
}

function closePause() {
  const now = new Date();
  const days = loadClock().days;
  for (const key of Object.keys(days)) {
    for (const p of days[key].pauses) {
      if (p.to) continue;
      // a pause that began on an earlier day ends at that day's midnight
      p.to = key === core.dateKey(now) ? now.toISOString() : new Date(core.parseDateKey(key).getTime() + 86400000 - 1000).toISOString();
    }
  }
  markActive(now);
  saveClock();
}

// The Pause button: a deliberate break (lunch) that is subtracted from the time at work.
// Unlocking the PC after a break also ends it.
function toggleBreak() {
  const now = new Date();
  const day = clockDay(now);
  const open = day.pauses.find((p) => !p.to);
  if (open && open.kind === 'manual') {
    open.to = now.toISOString();
  } else {
    if (open) open.to = now.toISOString();
    day.pauses.push({ from: now.toISOString(), to: null, kind: 'manual' });
  }
  saveClock();
  pushState();
}

function computeWorkday() {
  const settings = loadSettings();
  const now = new Date();
  const todayKey = core.dateKey(now);
  const entries = state.report && state.report.isCurrentWeek ? state.report.log.filter((e) => e.day === todayKey) : [];
  if (settings.demo) {
    const at = (h, m) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    const start = at(7, 50) < now ? at(7, 50) : now;
    const pauses = at(12, 45) < now ? [{ from: at(12, 5), to: at(12, 45), kind: 'lock' }] : [];
    // the Pause button also works in demo mode
    for (const p of clockDay(now).pauses) if (p.kind === 'manual') pauses.push({ from: new Date(p.from), to: p.to ? new Date(p.to) : null, kind: 'manual' });
    return { ...core.buildWorkday({ start, now, pauses, entries }), manual: false, demo: true };
  }
  const day = clockDay(now);
  const manual = day.manual ? new Date(day.manual) : null;
  const start = core.pickClockStart({
    now,
    bootTime: BOOT_TIME,
    appStart: day.appStart ? new Date(day.appStart) : null,
    firstActive: day.firstActive ? new Date(day.firstActive) : null,
    manual,
  });
  const pauses = day.pauses.map((p) => ({ from: new Date(p.from), to: p.to ? new Date(p.to) : null, kind: p.kind }));
  return { ...core.buildWorkday({ start, now, pauses, entries }), manual: !!manual, bootToday: core.dateKey(BOOT_TIME) === todayKey };
}

function setClockStart(value) {
  const now = new Date();
  const day = clockDay(now);
  if (value === null || value === '') {
    day.manual = null;
  } else {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value).trim());
    if (!m) throw new Error('Use a time like 07:30.');
    const when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]));
    if (when > now) throw new Error('The start cannot be in the future.');
    day.manual = when.toISOString();
  }
  saveClock();
  pushState();
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
      const fetchJson = makeFetcher(settings);
      const ctx = await jiraContext(fetchJson, settings);
      const now = new Date();
      const week = core.weekOf(now);
      report = core.buildReport(await core.loadEntriesRange(fetchJson, ctx, week.from, week.to), { displayName: ctx.displayName }, settings, now);
      report.deployment = ctx.deployment;
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
    state.ctx = null; // connect again next time (new sign-in, changed token, ...)
    if (state.error.kind === 'setup') state.report = null;
    if (reason !== 'startup' && state.error.kind !== 'setup') notify('Jira hours', `Update failed: ${state.error.message}`, 'warning');
  } finally {
    state.updating = false;
    state.lastUpdate = new Date().toISOString();
    state.lastReason = reason;
    pushState();
  }
}

async function jiraContext(fetchJson, settings) {
  const key = `${settings.baseUrl}|${settings.auth}|${settings.email}|${settings.categoryField}`;
  if (!state.ctx || state.ctx.key !== key) state.ctx = { key, ...(await core.connect(fetchJson, settings)) };
  return state.ctx;
}

// Any week (by its Monday, "YYYY-MM-DD") for browsing back; the current week comes from the last update
async function loadWeek(weekStart) {
  const settings = loadSettings();
  const weekDate = core.parseDateKey(weekStart) || new Date();
  const now = new Date();
  if (settings.demo) return core.demoReport(now, demoBumps, settings, weekDate);
  if (core.weekOf(weekDate).from === core.weekOf(now).from && state.report && !state.report.demo) return state.report;
  const fetchJson = makeFetcher(settings);
  const ctx = await jiraContext(fetchJson, settings);
  const week = core.weekOf(weekDate);
  const report = core.buildReport(await core.loadEntriesRange(fetchJson, ctx, week.from, week.to), { displayName: ctx.displayName }, settings, now, { weekDate });
  report.deployment = ctx.deployment;
  return report;
}

async function loadMonth(year, month) {
  const settings = loadSettings();
  const now = new Date();
  if (settings.demo) return core.demoMonth(now, demoBumps, settings, year, month);
  const fetchJson = makeFetcher(settings);
  const ctx = await jiraContext(fetchJson, settings);
  const grid = core.monthGrid(year, month);
  return core.buildMonth(await core.loadEntriesRange(fetchJson, ctx, grid.from, grid.to), settings, now, year, month);
}

function isAdmin(settings) {
  if (settings.demo) return true; // the demo shows the team view with sample colleagues
  return core.isAdminOf(state.ctx, settings.adminGroup, settings.jiraAdminsAreAdmins);
}

async function loadTeamWeek(weekStart) {
  const settings = loadSettings();
  const weekDate = core.parseDateKey(weekStart) || new Date();
  if (settings.demo) return core.demoTeamWeek(new Date(), demoBumps, settings, weekDate);
  const fetchJson = makeFetcher(settings);
  const ctx = await jiraContext(fetchJson, settings);
  if (!core.isAdminOf(ctx, settings.adminGroup, settings.jiraAdminsAreAdmins)) throw new Error('Only members of the admin group can see the team dashboard.');
  if (!settings.teamGroup) throw new Error('No team group set. Add it in Settings.');
  if (!state.members || state.members.group !== settings.teamGroup) {
    state.members = { group: settings.teamGroup, list: await core.loadGroupMembers(fetchJson, ctx, settings.teamGroup) };
  }
  const week = core.weekOf(weekDate);
  const entries = await core.loadEntriesRange(fetchJson, ctx, week.from, week.to, { group: settings.teamGroup, members: state.members.list });
  return core.buildTeamWeek(entries, state.members.list, settings, new Date(), { weekDate });
}

async function loadOverdue(scope) {
  const settings = loadSettings();
  const now = new Date();
  const team = scope === 'team';
  if (settings.demo) return core.demoOverdue(now, settings, team);
  const fetchJson = makeFetcher(settings);
  const ctx = await jiraContext(fetchJson, settings);
  if (team) {
    if (!core.isAdminOf(ctx, settings.adminGroup, settings.jiraAdminsAreAdmins)) throw new Error('Only members of the admin group can see the team\'s overdue tasks.');
    if (!settings.teamGroup) throw new Error('No team group set. Add it in Settings.');
    return core.loadOverdue(fetchJson, ctx, settings, now, { group: settings.teamGroup });
  }
  return core.loadOverdue(fetchJson, ctx, settings, now);
}

function resetProgress() {
  state.ctx = null;
  state.members = null;
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
    nextUpdate: scheduleText(settings),
    startView: CAPTURE_VIEW || null,
    isAdmin: isAdmin(settings),
    workday: computeWorkday(),
    version: app.getVersion(),
    // shown in Settings so a mismatching group name is easy to spot
    access: state.ctx ? { groups: state.ctx.groupNames || [], jiraAdmin: !!state.ctx.jiraAdmin, inAdminGroup: core.isAdminOf(state.ctx, settings.adminGroup) } : null,
    policy: Object.keys(state.policy),
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

function autoRefreshDue(settings) {
  if (!settings.autoRefreshMinutes || !state.lastUpdate || state.updating) return false;
  return Date.now() - new Date(state.lastUpdate).getTime() >= settings.autoRefreshMinutes * 60 * 1000;
}

function scheduleText(settings) {
  const parts = [];
  if (settings.autoRefreshMinutes) parts.push(`Updates every ${settings.autoRefreshMinutes < 60 ? `${settings.autoRefreshMinutes} min` : `${settings.autoRefreshMinutes / 60} h`}`);
  parts.push(core.nextUpdateText(settings.refreshTimes, new Date()).replace('Next automatic update', 'next reminder'));
  const text = parts.join(' \u00b7 ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function tick() {
  const todayKey = core.dateKey(new Date());
  if (lastClockDay && lastClockDay !== todayKey) {
    // the PC was in use across midnight: today's work starts now, unless the screen is locked
    const yesterday = loadClock().days[lastClockDay];
    const locked = yesterday && yesterday.pauses.some((p) => !p.to);
    if (!locked) markActive();
  }
  lastClockDay = todayKey;
  const settings = loadSettings();
  const slot = dueSlot(settings);
  if (slot) refresh(`scheduled ${slot}`);
  else if (state.lastDate && state.lastDate !== core.dateKey(new Date())) refresh('new day');
  else if (autoRefreshDue(settings)) refresh('automatic');
  else pushState(); // keeps the schedule text current
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
    { label: computeWorkday().onBreak ? 'Resume work' : 'Pause (break)', click: () => toggleBreak() },
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

// ------------------------------------------------------------------- export
const exportName = (report, ext) => `Jira-hours-${report.weekStart.slice(0, 4)}-W${String(report.weekNumber).padStart(2, '0')}.${ext}`;

async function renderPdf(report) {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  try {
    await win.loadFile(path.join(__dirname, 'ui', 'report.html'));
    const settings = loadSettings();
    const data = { report, groupLabel: settings.categoryField === 'sprint' ? 'Sprint' : 'Category', createdAt: new Date().toISOString() };
    await win.webContents.executeJavaScript(`window.renderReport(${JSON.stringify(data)}); true;`);
    return await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'custom', top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } });
  } finally {
    win.destroy();
  }
}

async function exportReport(kind, weekStart) {
  const report = await loadWeek(weekStart);
  const isPdf = kind === 'pdf';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: isPdf ? 'Save PDF report' : 'Save CSV for Excel',
    defaultPath: path.join(app.getPath('documents'), exportName(report, isPdf ? 'pdf' : 'csv')),
    filters: isPdf ? [{ name: 'PDF', extensions: ['pdf'] }] : [{ name: 'CSV (Excel)', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(result.filePath, isPdf ? await renderPdf(report) : core.exportCsv(report));
  if (isPdf) shell.openPath(result.filePath);
  else shell.showItemInFolder(result.filePath);
  return { ok: true, filePath: result.filePath };
}

// ---------------------------------------------------------------------- IPC
function registerIpc() {
  const safely = (fn) => async (...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, message: err.message || String(err), kind: err.kind }; }
  };
  ipcMain.handle('load-week', (_e, weekStart) => safely(loadWeek)(String(weekStart || '')));
  ipcMain.handle('load-month', (_e, year, month) => safely(loadMonth)(Number(year), Number(month)));
  ipcMain.handle('set-clock-start', (_e, value) => safely(setClockStart)(value));
  ipcMain.on('toggle-break', () => toggleBreak());
  ipcMain.on('open-jira', (_e, key) => {
    const settings = loadSettings();
    if (!settings.baseUrl || settings.demo) return;
    const ticket = typeof key === 'string' && /^[A-Z][A-Z0-9_]+-\d+$/.test(key) ? `/browse/${key}` : '/';
    shell.openExternal(`${settings.baseUrl}${ticket}`);
  });
  ipcMain.handle('load-team', (_e, weekStart) => safely(loadTeamWeek)(String(weekStart || '')));
  ipcMain.handle('load-overdue', (_e, scope) => safely(loadOverdue)(scope === 'team' ? 'team' : 'me'));
  ipcMain.handle('export', async (_e, kind, weekStart) => {
    try { return await exportReport(kind === 'pdf' ? 'pdf' : 'csv', String(weekStart || '')); } catch (err) { return { ok: false, message: err.message || String(err) }; }
  });

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
      const next = core.normalizeSettings({ ...current, baseUrl: address, auth: 'browser', demo: false, ...state.policy });
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
      const next = core.normalizeSettings({ ...current, ...input.settings, ...state.policy }); // IT policy always wins
      if (next.auth === 'token' && input.token) saveToken(String(input.token).trim());
      if (next.auth === 'token' && !next.demo && next.baseUrl && !loadToken()) throw new Error('Paste your API token, or choose "Sign in with Jira window".');
      writeSettings(next);
      if (typeof input.autostart === 'boolean') setAutostart(input.autostart);
      if (next.demo !== current.demo || next.baseUrl !== current.baseUrl || next.categoryField !== current.categoryField) resetProgress();
      if (next.teamGroup !== current.teamGroup || next.adminGroup !== current.adminGroup) state.members = null;
      refresh('settings');
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.on('rendered', () => {
    if (CAPTURE_PDF) {
      const day = new Date();
      if (CAPTURE_VIEW === 'past') day.setDate(day.getDate() - 7);
      loadWeek(core.dateKey(day)).then(renderPdf).then((pdf) => { fs.writeFileSync(CAPTURE_PDF, pdf); quitting = true; app.quit(); });
      return;
    }
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
  state.policy = readPolicy();
  markAppStart();
  lastClockDay = core.dateKey(new Date());
  // right after installation: start with Windows, so the clock starts when the PC starts
  if (FIRST_RUN) { try { setAutostart(true); } catch { /* user can switch it on in the tray menu */ } }
  powerMonitor.on('lock-screen', () => { openPause('lock'); pushState(); });
  powerMonitor.on('suspend', () => { openPause('sleep'); pushState(); });
  powerMonitor.on('unlock-screen', () => { closePause(); pushState(); });
  powerMonitor.on('resume', () => { closePause(); });
  registerIpc();
  createMainWindow();

  const settings = loadSettings();
  while (dueSlot(settings)) { /* times already passed today don't fire now */ }

  refresh('startup');
  setInterval(tick, 30 * 1000);
  powerMonitor.on('resume', () => refresh('resume'));
}
