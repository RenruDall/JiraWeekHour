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
  setTrayIcon: (dataUrl, tooltip) => ipcRenderer.send('tray-icon', dataUrl, tooltip),
  rendered: () => ipcRenderer.send('rendered'),
});
