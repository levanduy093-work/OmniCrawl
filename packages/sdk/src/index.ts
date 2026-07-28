import * as fs from 'fs';
import * as path from 'path';

export const RUN_STORAGE_SCHEMA_VERSION = '1.0';
export const RUN_INPUT_KIND = 'omnicrawl/run-input';
export const RUN_OUTPUT_KIND = 'omnicrawl/run-output';

export interface ActorReference {
  id?: string;
  name: string;
  version?: string;
}

export interface RunInputDocument<TInput = Record<string, unknown>> {
  schemaVersion: typeof RUN_STORAGE_SCHEMA_VERSION;
  kind: typeof RUN_INPUT_KIND;
  runId: string;
  actor: ActorReference;
  createdAt: string;
  payload: TInput;
}

export interface RunOutputDocument<TItem = unknown> {
  schemaVersion: typeof RUN_STORAGE_SCHEMA_VERSION;
  kind: typeof RUN_OUTPUT_KIND;
  runId: string;
  actor: ActorReference;
  status: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  stats: {
    itemCount: number;
  };
  metadata: Record<string, unknown>;
  items: TItem[];
  error: string | null;
}

export interface LegacyMigrationResult {
  runId: string;
  inputMigrated: boolean;
  outputMigrated: boolean;
  itemCount: number;
}

function getStorageRoot() {
  return process.env.OMNICRAWL_STORAGE_DIR || path.join(process.cwd(), 'storage');
}

export function getRunDirectory(runId: string) {
  return path.join(getStorageRoot(), 'runs', runId);
}

export function getRunInputPath(runId: string) {
  return path.join(getRunDirectory(runId), 'input.json');
}

export function getRunOutputPath(runId: string) {
  return path.join(getRunDirectory(runId), 'output.json');
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function atomicWriteJson(filePath: string, value: unknown) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  );
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

export function createRunInputDocument<TInput>(
  runId: string,
  actor: ActorReference,
  payload: TInput
): RunInputDocument<TInput> {
  return {
    schemaVersion: RUN_STORAGE_SCHEMA_VERSION,
    kind: RUN_INPUT_KIND,
    runId,
    actor,
    createdAt: new Date().toISOString(),
    payload
  };
}

export function writeRunInput<TInput>(
  runId: string,
  actor: ActorReference,
  payload: TInput
) {
  const document = createRunInputDocument(runId, actor, payload);
  atomicWriteJson(getRunInputPath(runId), document);
  return document;
}

export function readRunInputDocument<TInput = Record<string, unknown>>(
  runId: string
): RunInputDocument<TInput> | null {
  const current = readJson<RunInputDocument<TInput>>(getRunInputPath(runId));
  if (current?.kind === RUN_INPUT_KIND && current.runId === runId) return current;

  const legacyPath = path.join(
    getStorageRoot(),
    'key_value_stores',
    runId,
    'INPUT.json'
  );
  const legacy = readJson<TInput | RunInputDocument<TInput>>(legacyPath);
  if (!legacy) return null;
  if (
    typeof legacy === 'object' &&
    'kind' in legacy &&
    legacy.kind === RUN_INPUT_KIND &&
    'payload' in legacy
  ) {
    return legacy as RunInputDocument<TInput>;
  }
  return createRunInputDocument(runId, { name: 'unknown' }, legacy as TInput);
}

export function readRunInput<TInput = Record<string, unknown>>(runId: string): TInput {
  return readRunInputDocument<TInput>(runId)?.payload ?? ({} as TInput);
}

export function readRunOutput<TItem = unknown>(
  runId: string
): RunOutputDocument<TItem> | null {
  return readJson<RunOutputDocument<TItem>>(getRunOutputPath(runId));
}

function createRunOutput<TItem>(runId: string): RunOutputDocument<TItem> {
  const now = new Date().toISOString();
  const input = readRunInputDocument(runId);
  return {
    schemaVersion: RUN_STORAGE_SCHEMA_VERSION,
    kind: RUN_OUTPUT_KIND,
    runId,
    actor: input?.actor ?? { name: 'unknown' },
    status: 'RUNNING',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    stats: { itemCount: 0 },
    metadata: {},
    items: [],
    error: null
  };
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

export class Dataset<TItem = unknown> {
  private static locks = new Map<string, Promise<void>>();
  private runId: string;
  private outputPath: string;

  constructor(runId: string) {
    this.runId = runId;
    this.outputPath = getRunOutputPath(runId);
    fs.mkdirSync(getRunDirectory(runId), { recursive: true, mode: 0o700 });
  }

  private async locked<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = Dataset.locks.get(this.runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    Dataset.locks.set(this.runId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (Dataset.locks.get(this.runId) === queued) {
        Dataset.locks.delete(this.runId);
      }
    }
  }

  async pushData(data: TItem | TItem[]) {
    const items = Array.isArray(data) ? data : [data];
    if (!items.length) return;
    await this.locked(() => {
      const output = readRunOutput<TItem>(this.runId) ?? createRunOutput<TItem>(this.runId);
      output.items.push(...items);
      output.stats.itemCount = output.items.length;
      output.updatedAt = new Date().toISOString();
      atomicWriteJson(this.outputPath, output);
    });
  }

  async setMetadata(metadata: Record<string, unknown>) {
    await this.locked(() => {
      const output = readRunOutput<TItem>(this.runId) ?? createRunOutput<TItem>(this.runId);
      output.metadata = { ...output.metadata, ...metadata };
      output.updatedAt = new Date().toISOString();
      atomicWriteJson(this.outputPath, output);
    });
  }

  async getData() {
    return readRunOutput<TItem>(this.runId) ?? createRunOutput<TItem>(this.runId);
  }

  async finalize(status: string, error?: string) {
    await this.locked(() => {
      const output = readRunOutput<TItem>(this.runId) ?? createRunOutput<TItem>(this.runId);
      const now = new Date().toISOString();
      output.status = status;
      output.updatedAt = now;
      output.completedAt = now;
      output.stats.itemCount = output.items.length;
      output.error = error ? String(error).slice(0, 2000) : null;
      atomicWriteJson(this.outputPath, output);
    });
  }
}

export async function migrateLegacyRunStorage(
  runId: string,
  actor: ActorReference = { name: 'unknown' },
  status = 'UNKNOWN'
): Promise<LegacyMigrationResult> {
  const legacyInputPath = path.join(
    getStorageRoot(),
    'key_value_stores',
    runId,
    'INPUT.json'
  );
  const legacyDatasetDir = path.join(getStorageRoot(), 'datasets', runId);
  let inputMigrated = false;
  if (
    !fs.existsSync(getRunInputPath(runId)) &&
    (fs.existsSync(legacyInputPath) || fs.existsSync(legacyDatasetDir))
  ) {
    const payload = fs.existsSync(legacyInputPath)
      ? readJson<Record<string, unknown>>(legacyInputPath) ?? {}
      : {};
    writeRunInput(runId, actor, payload);
    if (fs.existsSync(legacyInputPath)) {
      fs.unlinkSync(legacyInputPath);
      const legacyStoreDir = path.dirname(legacyInputPath);
      if (fs.readdirSync(legacyStoreDir).length === 0) fs.rmdirSync(legacyStoreDir);
    }
    inputMigrated = true;
  }

  let outputMigrated = false;
  let itemCount = readRunOutput(runId)?.stats.itemCount ?? 0;
  if (fs.existsSync(legacyDatasetDir) && !fs.existsSync(getRunOutputPath(runId))) {
    const items = fs.readdirSync(legacyDatasetDir)
      .filter((filename) => filename.endsWith('.json'))
      .sort()
      .map((filename) => readJson(path.join(legacyDatasetDir, filename)))
      .filter((item) => item !== null);
    const dataset = new Dataset(runId);
    if (items.length) await dataset.pushData(items);
    await dataset.finalize(status);
    const output = readRunOutput(runId);
    if (!output || output.stats.itemCount !== items.length) {
      throw new Error(`Unable to verify migrated output for run ${runId}`);
    }
    fs.rmSync(legacyDatasetDir, { recursive: true, force: true });
    itemCount = items.length;
    outputMigrated = true;
  }

  return { runId, inputMigrated, outputMigrated, itemCount };
}

export function removeRunStorage(runId: string) {
  fs.rmSync(getRunDirectory(runId), { recursive: true, force: true });
  fs.rmSync(path.join(getStorageRoot(), 'datasets', runId), {
    recursive: true,
    force: true
  });
  const legacyInput = path.join(getStorageRoot(), 'key_value_stores', runId, 'INPUT.json');
  if (fs.existsSync(legacyInput)) fs.unlinkSync(legacyInput);
  const legacyStoreDir = path.dirname(legacyInput);
  if (fs.existsSync(legacyStoreDir) && fs.readdirSync(legacyStoreDir).length === 0) {
    fs.rmdirSync(legacyStoreDir);
  }
  fs.rmSync(path.join(getStorageRoot(), 'logs', `${runId}.log`), { force: true });
}

export class KeyValueStore {
  private storePath: string;

  constructor(storeId: string) {
    this.storePath = path.join(getStorageRoot(), 'key_value_stores', storeId);
    if (!fs.existsSync(this.storePath)) {
      fs.mkdirSync(this.storePath, { recursive: true });
    }
  }

  async setValue(key: string, value: any) {
    atomicWriteJson(path.join(this.storePath, `${key}.json`), value);
  }

  async getValue(key: string): Promise<any> {
    return readJson(path.join(this.storePath, `${key}.json`));
  }
}

export class ProxyManager {
  async getProxyUrl(): Promise<string | null> {
    return null;
  }
}

export interface ActorInput {
  [key: string]: any;
}

export class ActorContext<TInput extends ActorInput = any, TItem = unknown> {
  public input: TInput;
  public log: Logger;
  public dataset: Dataset<TItem>;
  public kv: KeyValueStore;
  public proxy: ProxyManager;
  public runId: string;
  public userId?: string;

  constructor(runId: string, input: TInput, userId?: string) {
    this.runId = runId;
    this.userId = userId;
    this.input = input;
    this.log = new Logger();
    this.dataset = new Dataset<TItem>(runId);
    this.kv = new KeyValueStore(runId);
    this.proxy = new ProxyManager();
  }
}
