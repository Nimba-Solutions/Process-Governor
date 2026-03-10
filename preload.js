/**
 * @name         Process Governor
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Preload script — exposes IPC bridge to the renderer process.
 * @author       Cloud Nimbus LLC
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getTopProcesses: () => ipcRenderer.invoke('get-top-processes'),
  getSystemStats: () => ipcRenderer.invoke('get-system-stats'),

  getRules: () => ipcRenderer.invoke('get-rules'),
  getActiveRules: () => ipcRenderer.invoke('get-active-rules'),
  saveRule: (rule) => ipcRenderer.invoke('save-rule', rule),
  removeRule: (id) => ipcRenderer.invoke('remove-rule', id),
  startRule: (id) => ipcRenderer.invoke('start-rule', id),
  stopRule: (id) => ipcRenderer.invoke('stop-rule', id),
  stopAllRules: () => ipcRenderer.invoke('stop-all-rules'),

  applyPreset: (key) => ipcRenderer.invoke('apply-preset', key),
  getPresets: () => ipcRenderer.invoke('get-presets'),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),

  killProcess: (pid) => ipcRenderer.invoke('kill-process', pid),
  checkAdmin: () => ipcRenderer.invoke('check-admin'),
  selfElevate: () => ipcRenderer.invoke('self-elevate'),

  onRulesChanged: (cb) => ipcRenderer.on('rules-changed', (_, ids) => cb(ids)),
});
