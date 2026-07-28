import * as fs from 'fs';
import * as path from 'path';

function getStorageRoot() {
  return process.env.OMNICRAWL_STORAGE_DIR || path.join(process.cwd(), 'storage');
}

export class Logger {
  info(message: string, ...meta: any[]) {
    console.log(`[INFO] ${message}`, ...meta);
  }
  error(message: string, ...meta: any[]) {
    console.error(`[ERROR] ${message}`, ...meta);
  }
  warn(message: string, ...meta: any[]) {
    console.warn(`[WARN] ${message}`, ...meta);
  }
}

export class Dataset {
  private runId: string;
  private datasetPath: string;

  constructor(runId: string) {
    this.runId = runId;
    this.datasetPath = path.join(getStorageRoot(), 'datasets', runId);
    if (!fs.existsSync(this.datasetPath)) {
      fs.mkdirSync(this.datasetPath, { recursive: true });
    }
  }

  async pushData(data: any | any[]) {
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      const filename = `${Date.now()}_${Math.random().toString(36).substring(7)}.json`;
      fs.writeFileSync(path.join(this.datasetPath, filename), JSON.stringify(item, null, 2));
    }
  }
}

export class KeyValueStore {
  private storeId: string;
  private storePath: string;

  constructor(storeId: string) {
    this.storeId = storeId;
    this.storePath = path.join(getStorageRoot(), 'key_value_stores', storeId);
    if (!fs.existsSync(this.storePath)) {
      fs.mkdirSync(this.storePath, { recursive: true });
    }
  }

  async setValue(key: string, value: any) {
    fs.writeFileSync(path.join(this.storePath, `${key}.json`), JSON.stringify(value));
  }

  async getValue(key: string): Promise<any> {
    const file = path.join(this.storePath, `${key}.json`);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
    return null;
  }
}

export class ProxyManager {
  async getProxyUrl(): Promise<string | null> {
    // Mock implementation for Phase 4
    return null; 
  }
}

export interface ActorInput {
  [key: string]: any;
}

export class ActorContext<TInput extends ActorInput = any> {
  public input: TInput;
  public log: Logger;
  public dataset: Dataset;
  public kv: KeyValueStore;
  public proxy: ProxyManager;
  public runId: string;
  public userId?: string;

  constructor(runId: string, input: TInput, userId?: string) {
    this.runId = runId;
    this.userId = userId;
    this.input = input;
    this.log = new Logger();
    this.dataset = new Dataset(runId);
    this.kv = new KeyValueStore(runId);
    this.proxy = new ProxyManager();
  }
}
