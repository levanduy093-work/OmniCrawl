import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { DatasetItem, RunStatus, RunSummary } from '../shared/contracts';

interface RunRow {
  id: string;
  actor_name: string;
  status: RunStatus;
  input_json: string;
  item_count: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface ItemRow {
  id: number;
  run_id: string;
  external_key: string | null;
  data_json: string;
  created_at: string;
}

function now() {
  return new Date().toISOString();
}

function runFromRow(row: RunRow): RunSummary {
  return {
    id: row.id,
    actorName: row.actor_name,
    status: row.status,
    input: JSON.parse(row.input_json) as Record<string, unknown>,
    itemCount: row.item_count,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

export class DesktopDatabase {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        actor_name TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        item_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS runs_created_at_idx ON runs(created_at DESC);

      CREATE TABLE IF NOT EXISTS dataset_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        external_key TEXT,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, external_key)
      );

      CREATE INDEX IF NOT EXISTS dataset_items_run_idx ON dataset_items(run_id, id);

      CREATE TABLE IF NOT EXISTS run_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        synced_at TEXT
      );

      CREATE INDEX IF NOT EXISTS sync_outbox_pending_idx ON sync_outbox(synced_at, id);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.db.prepare(
      `INSERT OR IGNORE INTO settings (key, value) VALUES ('cloudSyncEnabled', 'false')`
    ).run();
  }

  createRun(actorName: string, input: Record<string, unknown>) {
    const id = randomUUID();
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO runs (id, actor_name, status, input_json, created_at)
      VALUES (?, ?, 'PENDING', ?, ?)
    `).run(id, actorName, JSON.stringify(input), createdAt);
    this.enqueue('RUN_CREATED', id, { actorName, input, createdAt });
    return this.getRun(id)!;
  }

  getRun(id: string) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  listRuns() {
    return (this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all() as RunRow[])
      .map(runFromRow);
  }

  updateRun(id: string, status: RunStatus, error: string | null = null) {
    const current = this.getRun(id);
    if (!current) throw new Error(`Run ${id} not found`);
    const startedAt = status === 'RUNNING' && !current.startedAt ? now() : current.startedAt;
    const terminal = ['STOPPED', 'SUCCESS', 'PARTIAL', 'FAILED'].includes(status);
    const finishedAt = terminal ? now() : null;
    this.db.prepare(`
      UPDATE runs
      SET status = ?, error = ?, started_at = ?, finished_at = ?
      WHERE id = ?
    `).run(status, error, startedAt, finishedAt, id);
    const updated = this.getRun(id)!;
    this.enqueue('RUN_UPDATED', id, updated);
    return updated;
  }

  addItem(runId: string, externalKey: string | null, data: Record<string, unknown>) {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO dataset_items (run_id, external_key, data_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(runId, externalKey, JSON.stringify(data), now());
    if (result.changes === 0) return false;
    this.db.prepare(`
      UPDATE runs SET item_count = item_count + 1 WHERE id = ?
    `).run(runId);
    this.enqueue('ITEM_UPSERTED', runId, { externalKey, data });
    return true;
  }

  getRunItems(runId: string) {
    return (this.db.prepare(`
      SELECT * FROM dataset_items WHERE run_id = ? ORDER BY id ASC
    `).all(runId) as ItemRow[]).map((row): DatasetItem => ({
      id: row.id,
      runId: row.run_id,
      externalKey: row.external_key,
      data: JSON.parse(row.data_json) as Record<string, unknown>,
      createdAt: row.created_at
    }));
  }

  addLog(runId: string, level: string, message: string) {
    this.db.prepare(`
      INSERT INTO run_logs (run_id, level, message, created_at) VALUES (?, ?, ?, ?)
    `).run(runId, level, message, now());
  }

  getBooleanSetting(key: string) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value === 'true';
  }

  private enqueue(eventType: string, aggregateId: string, payload: unknown) {
    this.db.prepare(`
      INSERT INTO sync_outbox (
        event_id, aggregate_id, event_type, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), aggregateId, eventType, JSON.stringify(payload), now());
  }

  close() {
    this.db.close();
  }
}
