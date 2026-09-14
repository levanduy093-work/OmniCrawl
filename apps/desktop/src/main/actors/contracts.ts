import type { ActorSummary, RunStatus } from '../../shared/contracts';
import type { BrowserManager } from '../browser/browser-manager';
import type { DesktopDatabase } from '../database';

export class ManualInterventionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualInterventionError';
  }
}

export interface ActorExecutionContext {
  runId: string;
  input: Record<string, unknown>;
  browser: BrowserManager;
  database: DesktopDatabase;
  signal: AbortSignal;
  log(message: string): void;
  emitProgress(): void;
}

export interface ActorExecutionResult {
  status: Extract<RunStatus, 'SUCCESS' | 'PARTIAL'>;
  error?: string;
}

export interface DesktopActor {
  summary: ActorSummary;
  validateInput(input: Record<string, unknown>): Record<string, unknown>;
  execute(context: ActorExecutionContext): Promise<ActorExecutionResult>;
}
