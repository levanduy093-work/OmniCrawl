export type RunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'PAUSED'
  | 'STOPPING'
  | 'STOPPED'
  | 'SUCCESS'
  | 'PARTIAL'
  | 'FAILED';

export interface ActorSummary {
  name: string;
  title: string;
  description: string;
  platform: string;
  version: string;
  inputSchema: Record<string, unknown>;
  capabilities: string[];
}

export interface RunSummary {
  id: string;
  actorName: string;
  status: RunStatus;
  input: Record<string, unknown>;
  itemCount: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DatasetItem {
  id: number;
  runId: string;
  externalKey: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface AppStatus {
  version: string;
  dataPath: string;
  cloudSyncEnabled: boolean;
  browser: {
    visible: boolean;
    platform: string | null;
    profileId: string | null;
    url: string | null;
    notice: string | null;
  };
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OmniCrawlDesktopApi {
  getStatus(): Promise<AppStatus>;
  listActors(): Promise<ActorSummary[]>;
  listRuns(): Promise<RunSummary[]>;
  getRunItems(runId: string): Promise<DatasetItem[]>;
  startRun(actorName: string, input: Record<string, unknown>): Promise<RunSummary>;
  stopRun(runId: string): Promise<void>;
  openPlatform(platform: string, profileId?: string): Promise<void>;
  setBrowserVisible(visible: boolean): Promise<void>;
  setBrowserBounds(bounds: BrowserBounds): Promise<void>;
  navigateBrowser(url: string): Promise<void>;
  exportRun(runId: string, format: 'csv' | 'jsonl'): Promise<string | null>;
  loginWithChrome(platform: string, profileId?: string): Promise<{ success: boolean; count: number; error?: string }>;
  importCookies(platform: string, raw: string, profileId?: string): Promise<{ count: number }>;
  reloadBrowser(): Promise<void>;
  onRunChanged(callback: (run: RunSummary) => void): () => void;
  onBrowserChanged(callback: (status: AppStatus['browser']) => void): () => void;
}


declare global {
  interface Window {
    omnicrawl: OmniCrawlDesktopApi;
  }
}
