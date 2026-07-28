import * as fs from 'fs';
import * as path from 'path';
import { Prisma, prisma } from '@omnicrawl/database';

export const RUN_STORAGE_SCHEMA_VERSION = '2.0';
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
  runMissing: boolean;
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

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Value cannot be serialized as JSON');
  }
  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function actorReference(actor: { id: string; name: string; version: string }): ActorReference {
  return { id: actor.id, name: actor.name, version: actor.version };
}

function itemExternalKey(value: Prisma.InputJsonValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, Prisma.JsonValue>;
  const candidate = record.itemId ?? record.id ?? record.url;
  return candidate === null || candidate === undefined || candidate === ''
    ? null
    : String(candidate).slice(0, 2000);
}

export async function writeRunInput<TInput>(
  runId: string,
  _actor: ActorReference,
  payload: TInput
) {
  const run = await prisma.run.update({
    where: { id: runId },
    data: { input: toJsonValue(payload) },
    include: { actor: true }
  });
  return {
    schemaVersion: RUN_STORAGE_SCHEMA_VERSION,
    kind: RUN_INPUT_KIND,
    runId,
    actor: actorReference(run.actor),
    createdAt: run.createdAt.toISOString(),
    payload
  } as RunInputDocument<TInput>;
}

export async function readRunInputDocument<TInput = Record<string, unknown>>(
  runId: string
): Promise<RunInputDocument<TInput> | null> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: { actor: true }
  });
  if (!run) return null;
  return {
    schemaVersion: RUN_STORAGE_SCHEMA_VERSION,
    kind: RUN_INPUT_KIND,
    runId,
    actor: actorReference(run.actor),
    createdAt: run.createdAt.toISOString(),
    payload: (run.input ?? {}) as TInput
  };
}

export async function readRunInput<TInput = Record<string, unknown>>(
  runId: string
): Promise<TInput> {
  return (await readRunInputDocument<TInput>(runId))?.payload ?? ({} as TInput);
}

export async function readRunOutput<TItem = unknown>(
  runId: string
): Promise<RunOutputDocument<TItem> | null> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      actor: true,
      items: { orderBy: { position: 'asc' } }
    }
  });
  if (!run) return null;
  return {
    schemaVersion: RUN_STORAGE_SCHEMA_VERSION,
    kind: RUN_OUTPUT_KIND,
    runId,
    actor: actorReference(run.actor),
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    completedAt: run.finishedAt?.toISOString() ?? null,
    stats: { itemCount: run.itemCount },
    metadata: asRecord(run.outputMetadata),
    items: run.items.map((item) => item.data as TItem),
    error: run.outputError
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

  constructor(private readonly runId: string) {}

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
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
      if (Dataset.locks.get(this.runId) === queued) Dataset.locks.delete(this.runId);
    }
  }

  async pushData(data: TItem | TItem[]) {
    const items = (Array.isArray(data) ? data : [data]).map(toJsonValue);
    if (!items.length) return;

    await this.locked(async () => {
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        try {
          await prisma.$transaction(async (tx) => {
            const run = await tx.run.findUnique({
              where: { id: this.runId },
              select: { itemCount: true }
            });
            if (!run) throw new Error(`Run ${this.runId} not found`);
            await tx.datasetItem.createMany({
              data: items.map((item, index) => ({
                runId: this.runId,
                position: run.itemCount + index,
                externalKey: itemExternalKey(item),
                data: item
              }))
            });
            await tx.run.update({
              where: { id: this.runId },
              data: { itemCount: { increment: items.length } }
            });
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
          return;
        } catch (error: any) {
          if (!['P2002', 'P2034'].includes(error?.code) || attempt === 6) throw error;
          await new Promise((resolve) => setTimeout(resolve, attempt * 10));
        }
      }
    });
  }

  async setMetadata(metadata: Record<string, unknown>) {
    const run = await prisma.run.findUnique({
      where: { id: this.runId },
      select: { outputMetadata: true }
    });
    if (!run) throw new Error(`Run ${this.runId} not found`);
    await prisma.run.update({
      where: { id: this.runId },
      data: {
        outputMetadata: toJsonValue({
          ...asRecord(run.outputMetadata),
          ...metadata
        })
      }
    });
  }

  async updateData(externalKey: string, patch: Record<string, unknown>) {
    return this.locked(async () => {
      const item = await prisma.datasetItem.findFirst({
        where: {
          runId: this.runId,
          externalKey: String(externalKey)
        },
        select: { id: true, data: true }
      });
      if (!item) return false;
      await prisma.datasetItem.update({
        where: { id: item.id },
        data: {
          data: toJsonValue({
            ...asRecord(item.data),
            ...patch
          })
        }
      });
      return true;
    });
  }

  async getData() {
    const output = await readRunOutput<TItem>(this.runId);
    if (!output) throw new Error(`Run ${this.runId} not found`);
    return output;
  }

  async finalize(status: string, error?: string) {
    await prisma.run.update({
      where: { id: this.runId },
      data: {
        status,
        finishedAt: new Date(),
        outputError: error ? String(error).slice(0, 2000) : null
      }
    });
  }
}

export async function migrateLegacyRunStorage(
  runId: string,
  _actor: ActorReference = { name: 'unknown' },
  _status = 'UNKNOWN'
): Promise<LegacyMigrationResult> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { id: true, input: true, itemCount: true }
  });
  if (!run) {
    return {
      runId,
      inputMigrated: false,
      outputMigrated: false,
      itemCount: 0,
      runMissing: true
    };
  }

  const currentInput = readJson<any>(getRunInputPath(runId));
  const legacyInputPath = path.join(getStorageRoot(), 'key_value_stores', runId, 'INPUT.json');
  const legacyInput = readJson<any>(legacyInputPath);
  const inputPayload = currentInput?.kind === 'omnicrawl/run-input'
    ? currentInput.payload
    : legacyInput?.kind === 'omnicrawl/run-input'
      ? legacyInput.payload
      : legacyInput;
  let inputMigrated = false;
  if (run.input === null && inputPayload !== null && inputPayload !== undefined) {
    await prisma.run.update({
      where: { id: runId },
      data: { input: toJsonValue(inputPayload) }
    });
    inputMigrated = true;
  }

  const currentOutput = readJson<any>(getRunOutputPath(runId));
  const legacyDatasetDir = path.join(getStorageRoot(), 'datasets', runId);
  const legacyItems = fs.existsSync(legacyDatasetDir)
    ? fs.readdirSync(legacyDatasetDir)
      .filter((filename) => filename.endsWith('.json'))
      .sort()
      .map((filename) => readJson(path.join(legacyDatasetDir, filename)))
      .filter((item) => item !== null)
    : [];
  const outputItems = Array.isArray(currentOutput?.items) ? currentOutput.items : legacyItems;
  let outputMigrated = false;
  if (run.itemCount === 0 && outputItems.length > 0) {
    const dataset = new Dataset(runId);
    await dataset.pushData(outputItems);
    await prisma.run.update({
      where: { id: runId },
      data: {
        outputMetadata: toJsonValue(currentOutput?.metadata ?? {}),
        outputError: currentOutput?.error ? String(currentOutput.error).slice(0, 2000) : null
      }
    });
    outputMigrated = true;
  }

  const verified = await prisma.run.findUnique({
    where: { id: runId },
    select: { itemCount: true, input: true }
  });
  const expectedItems = outputItems.length || run.itemCount;
  if (!verified || verified.itemCount !== expectedItems) {
    throw new Error(`Unable to verify database migration for run ${runId}`);
  }
  if (inputPayload !== null && inputPayload !== undefined && verified.input === null) {
    throw new Error(`Unable to verify input migration for run ${runId}`);
  }

  fs.rmSync(getRunDirectory(runId), { recursive: true, force: true });
  fs.rmSync(legacyDatasetDir, { recursive: true, force: true });
  if (fs.existsSync(legacyInputPath)) fs.unlinkSync(legacyInputPath);
  const legacyStoreDir = path.dirname(legacyInputPath);
  if (fs.existsSync(legacyStoreDir) && fs.readdirSync(legacyStoreDir).length === 0) {
    fs.rmdirSync(legacyStoreDir);
  }

  return {
    runId,
    inputMigrated,
    outputMigrated,
    itemCount: verified.itemCount,
    runMissing: false
  };
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
    const filePath = path.join(this.storePath, `${key}.json`);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
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
