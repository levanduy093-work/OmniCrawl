import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppStatus,
  BrowserBounds,
  OmniCrawlDesktopApi,
  RunSummary
} from '../shared/contracts';

const api: OmniCrawlDesktopApi = {
  getStatus: () => ipcRenderer.invoke('app:get-status'),
  listActors: () => ipcRenderer.invoke('actors:list'),
  listRuns: () => ipcRenderer.invoke('runs:list'),
  getRunItems: (runId) => ipcRenderer.invoke('runs:items', runId),
  startRun: (actorName, input) => ipcRenderer.invoke('runs:start', actorName, input),
  stopRun: (runId) => ipcRenderer.invoke('runs:stop', runId),
  openPlatform: (platform, profileId) => ipcRenderer.invoke('browser:open', platform, profileId),
  setBrowserVisible: (visible) => ipcRenderer.invoke('browser:set-visible', visible),
  setBrowserBounds: (bounds: BrowserBounds) => ipcRenderer.invoke('browser:set-bounds', bounds),
  navigateBrowser: (url) => ipcRenderer.invoke('browser:navigate', url),
  exportRun: (runId, format) => ipcRenderer.invoke('runs:export', runId, format),
  loginWithChrome: (platform, profileId) => ipcRenderer.invoke('browser:login-with-chrome', platform, profileId),
  importCookies: (platform, raw, profileId) => ipcRenderer.invoke('browser:import-cookies', platform, raw, profileId),
  reloadBrowser: () => ipcRenderer.invoke('browser:reload'),
  onRunChanged: (callback) => {

    const listener = (_event: Electron.IpcRendererEvent, run: RunSummary) => callback(run);
    ipcRenderer.on('runs:changed', listener);
    return () => ipcRenderer.removeListener('runs:changed', listener);
  },
  onBrowserChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: AppStatus['browser']) => callback(value);
    ipcRenderer.on('browser:changed', listener);
    return () => ipcRenderer.removeListener('browser:changed', listener);
  }
};

contextBridge.exposeInMainWorld('omnicrawl', api);
