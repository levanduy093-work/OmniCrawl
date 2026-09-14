import { EventEmitter } from 'node:events';
import type { RunSummary } from '../../shared/contracts';
import type { ActorRegistry } from '../actors/registry';
import { ManualInterventionError } from '../actors/contracts';
import type { BrowserManager } from '../browser/browser-manager';
import type { DesktopDatabase } from '../database';

export class RunService extends EventEmitter {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly database: DesktopDatabase,
    private readonly actors: ActorRegistry,
    private readonly browser: BrowserManager
  ) {
    super();
  }

  start(actorName: string, rawInput: Record<string, unknown>) {
    const actor = this.actors.get(actorName);
    if (!actor) throw new Error(`Actor ${actorName} is not installed.`);
    const input = actor.validateInput(rawInput);
    const run = this.database.createRun(actorName, input);
    this.emitRun(run);
    void this.execute(run);
    return run;
  }

  async stop(runId: string) {
    const controller = this.active.get(runId);
    if (!controller) {
      const run = this.database.getRun(runId);
      if (run?.status === 'PAUSED' || run?.status === 'PENDING') {
        this.emitRun(this.database.updateRun(runId, 'STOPPED'));
      }
      return;
    }
    this.emitRun(this.database.updateRun(runId, 'STOPPING'));
    controller.abort(new Error('Task đã được người dùng dừng.'));
  }

  private async execute(run: RunSummary) {
    const actor = this.actors.get(run.actorName);
    if (!actor) return;
    const controller = new AbortController();
    this.active.set(run.id, controller);
    this.emitRun(this.database.updateRun(run.id, 'RUNNING'));

    try {
      const result = await actor.execute({
        runId: run.id,
        input: run.input,
        browser: this.browser,
        database: this.database,
        signal: controller.signal,
        log: (message) => this.database.addLog(run.id, 'INFO', message),
        emitProgress: () => {
          const updated = this.database.getRun(run.id);
          if (updated) this.emitRun(updated);
        }
      });
      this.emitRun(this.database.updateRun(run.id, result.status, result.error ?? null));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        this.emitRun(this.database.updateRun(run.id, 'STOPPED', message));
      } else if (error instanceof ManualInterventionError) {
        this.emitRun(this.database.updateRun(run.id, 'PAUSED', message));
      } else {
        this.emitRun(this.database.updateRun(run.id, 'FAILED', message));
      }
    } finally {
      this.active.delete(run.id);
    }
  }

  private emitRun(run: RunSummary) {
    this.emit('changed', run);
  }
}
