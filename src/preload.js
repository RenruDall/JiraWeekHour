'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jwh', {
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onOpenSettings: (fn) => ipcRenderer.on('open-settings', () => fn()),
  ready: () => ipcRenderer.send('ready'),
  refresh: () => ipcRenderer.send('refresh'),
  signIn: () => ipcRenderer.send('sign-in'),
  connect: (address) => ipcRenderer.invoke('connect', address),
  disconnect: () => ipcRenderer.send('disconnect'),
  saveSettings: (input) => ipcRenderer.invoke('save-settings', input),
  loadWeek: (weekStart) => ipcRenderer.invoke('load-week', weekStart),
  loadMonth: (year, month) => ipcRenderer.invoke('load-month', year, month),
  loadTeam: (weekStart) => ipcRenderer.invoke('load-team', weekStart),
  loadOverdue: (scope) => ipcRenderer.invoke('load-overdue', scope),
  setClockStart: (value) => ipcRenderer.invoke('set-clock-start', value),
  setLunchDay: (input) => ipcRenderer.invoke('set-lunch-day', input),
  searchUsers: (query) => ipcRenderer.invoke('search-users', query),
  teamCandidates: () => ipcRenderer.invoke('team-candidates'),
  setTeamMembers: (list) => ipcRenderer.invoke('set-team-members', list),
  openJira: (key) => ipcRenderer.send('open-jira', key),
  exportReport: (kind, weekStart) => ipcRenderer.invoke('export', kind, weekStart),
  setTrayIcon: (dataUrl, tooltip) => ipcRenderer.send('tray-icon', dataUrl, tooltip),
  rendered: () => ipcRenderer.send('rendered'),
});
