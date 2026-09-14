import { app, BrowserWindow, ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrowserBounds } from '../shared/contracts';
import { ActorRegistry } from './actors/registry';
import { shopeeSearchActor } from './actors/shopee-search';
import { BrowserManager } from './browser/browser-manager';
import { ProfileManager } from './browser/profile-manager';
import { DesktopDatabase } from './database';
import { ExportService } from './export-service';
import { RunService } from './runtime/run-service';

let mainWindow: BrowserWindow | null = null;
let database: DesktopDatabase | null = null;
let browser: BrowserManager | null = null;

app.setName('OmniCrawl Desktop');
app.setPath('userData', path.join(app.getPath('appData'), 'OmniCrawl Desktop'));

function assertRenderer(event: Electron.IpcMainInvokeEvent) {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('Rejected IPC request from an unknown renderer.');
  }
}

async function createApplication() {
  const profiles = new ProfileManager();
  profiles.configureDefault();
  app.userAgentFallback = profiles.getUserAgent();

  const dataPath = path.join(app.getPath('userData'), 'runtime');
  fs.mkdirSync(dataPath, { recursive: true });
  database = new DesktopDatabase(path.join(dataPath, 'omnicrawl.db'));

  const actors = new ActorRegistry();
  actors.register(shopeeSearchActor);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#f4f1ea',
    title: 'OmniCrawl Desktop',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  browser = new BrowserManager(mainWindow, profiles, (state) => {
    mainWindow?.webContents.send('browser:changed', state);
  });

  const runService = new RunService(database, actors, browser);
  const exports = new ExportService(database);
  runService.on('changed', (run) => mainWindow?.webContents.send('runs:changed', run));

  const handle = <T extends unknown[]>(
    channel: string,
    listener: (event: Electron.IpcMainInvokeEvent, ...args: T) => unknown
  ) => ipcMain.handle(channel, (event, ...args: T) => {
    assertRenderer(event);
    return listener(event, ...args);
  });

  handle('app:get-status', () => ({
    version: app.getVersion(),
    dataPath,
    cloudSyncEnabled: database!.getBooleanSetting('cloudSyncEnabled'),
    browser: browser!.getState()
  }));
  handle('actors:list', () => actors.list());
  handle('runs:list', () => database!.listRuns());
  handle('runs:items', (_event, runId: string) => database!.getRunItems(String(runId)));
  handle('runs:start', (_event, actorName: string, input: Record<string, unknown>) => (
    runService.start(String(actorName), input ?? {})
  ));
  handle('runs:stop', (_event, runId: string) => runService.stop(String(runId)));
  handle('runs:export', (_event, runId: string, format: 'csv' | 'jsonl') => {
    if (!['csv', 'jsonl'].includes(format)) throw new Error('Unsupported export format.');
    return exports.exportRun(String(runId), format);
  });
  handle('browser:open', (_event, platform: string, profileId?: string) => (
    browser!.openPlatform(String(platform), String(profileId || 'default'))
  ));
  handle('browser:set-visible', (_event, visible: boolean) => browser!.setVisible(Boolean(visible)));
  handle('browser:set-bounds', (_event, bounds: BrowserBounds) => browser!.setBounds(bounds));
  handle('browser:navigate', (_event, url: string) => browser!.loadURL(String(url)));
  handle('browser:login-with-chrome', (_event, platform: string, profileId?: string) => (
    browser!.loginWithChrome(String(platform || 'shopee'), String(profileId || 'default'))
  ));
  handle('browser:import-cookies', (_event, platform: string, rawCookies: string, profileId?: string) => (
    browser!.importCookies(String(platform || 'shopee'), String(rawCookies), String(profileId || 'default'))
  ));
  handle('browser:reload', () => browser!.reload());


  const devUrl = process.env.OMNICRAWL_DESKTOP_DEV_URL;
  if (devUrl) await mainWindow.loadURL(devUrl);
  else await mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
  if (mainWindow && !mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.on('closed', () => {
    browser?.destroy();
    browser = null;
    mainWindow = null;
  });

}

app.whenReady().then(createApplication).catch((error) => {
  console.error('[OmniCrawl Desktop] startup failed', error);
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  database?.close();
  database = null;
});
