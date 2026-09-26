import type { HubBatchCommand, HubBatchResultView, HubSnapshotView } from '@rp/contracts';
import type { Database } from '@rp/infrastructure';
import {
  applyMovements,
  applySnapshot,
  completeBatch,
  failBatch,
  getState,
  type HubIdentity,
  type OutboxStats,
  outboxStats,
  recoverInFlight,
  setState,
  takeBatch,
} from './store';

/** How the hub reaches the cloud API (HTTPS in production, in-process in tests). */
export interface CloudPort {
  snapshot(since: string | null): Promise<HubSnapshotView>;
  upload(batch: HubBatchCommand): Promise<HubBatchResultView>;
}

export type CloudState =
  /** Last attempt reached the cloud. */
  | 'connected'
  /** The cloud could not be reached (no internet, DNS, timeout). Local operation continues. */
  | 'offline'
  /** The cloud answered but refused (e.g. hub not attached, revoked). Needs a person. */
  | 'refused';

export interface SyncStatus {
  cloud: CloudState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  identity: HubIdentity | null;
  outbox: OutboxStats;
}

export interface SyncReport {
  uploaded: number;
  conflicts: number;
  movementsApplied: number;
  snapshotApplied: boolean;
}

/** An error thrown by the CloudPort when the cloud answered with a refusal (4xx), not a network failure. */
export class CloudRefusedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CloudRefusedError';
  }
}

export class SyncEngine {
  private cloud: CloudState = 'offline';
  private lastAttemptAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private running: Promise<SyncReport> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;

  constructor(
    private readonly db: Database,
    private readonly port: CloudPort,
    private readonly options: {
      newId: () => string;
      now?: () => Date;
      batchSize?: number;
      /** Upper bound on batches per run, so one run never blocks for long. */
      maxBatches?: number;
      onError?: (error: unknown) => void;
    },
  ) {}

  /** Call once at start-up: uploads interrupted by a crash are sent again. */
  async init(): Promise<void> {
    await recoverInFlight(this.db);
  }

  /** One full cycle: upload pending floor records, then refresh configuration and stock. Never runs twice at once. */
  syncOnce(): Promise<SyncReport> {
    if (!this.running) this.running = this.cycle().finally(() => (this.running = null));
    return this.running;
  }

  private async cycle(): Promise<SyncReport> {
    const now = () => (this.options.now?.() ?? new Date()).toISOString();
    this.lastAttemptAt = now();
    const report: SyncReport = { uploaded: 0, conflicts: 0, movementsApplied: 0, snapshotApplied: false };
    try {
      const identity = await getState<HubIdentity>(this.db, 'identity');
      // Upload first: records refer to configuration the cloud already has.
      if (identity?.attached) {
        for (let i = 0; i < (this.options.maxBatches ?? 20); i++) {
          const taken = await takeBatch(this.db, this.options.newId(), this.options.batchSize ?? 200);
          if (!taken) break;
          let result: HubBatchResultView;
          try {
            result = await this.port.upload(taken.command);
          } catch (error) {
            await failBatch(this.db, taken, errorText(error));
            throw error;
          }
          await completeBatch(this.db, taken, result);
          report.uploaded += result.records - result.conflicts.length;
          report.conflicts += result.conflicts.length;
        }
      }
      const since = await getState<string>(this.db, 'movements_since');
      const snapshot = await this.port.snapshot(since);
      await applySnapshot(this.db, snapshot);
      report.snapshotApplied = true;
      report.movementsApplied = await applyMovements(this.db, snapshot.movements, snapshot.generatedAt);
      this.cloud = 'connected';
      this.lastSuccessAt = now();
      this.lastError = null;
      this.failures = 0;
      await setState(this.db, 'last_sync', { at: this.lastSuccessAt });
      return report;
    } catch (error) {
      this.cloud = error instanceof CloudRefusedError ? 'refused' : 'offline';
      this.lastError = errorText(error);
      this.failures++;
      this.options.onError?.(error);
      return report;
    }
  }

  async status(): Promise<SyncStatus> {
    return {
      cloud: this.cloud,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt ?? (await getState<{ at: string }>(this.db, 'last_sync'))?.at ?? null,
      lastError: this.lastError,
      identity: await getState<HubIdentity>(this.db, 'identity'),
      outbox: await outboxStats(this.db),
    };
  }

  /** Runs continuously: every `intervalMs` when healthy, backing off to `maxBackoffMs` while the cloud is unreachable. */
  start(intervalMs = 15_000, maxBackoffMs = 5 * 60_000): void {
    const tick = async () => {
      await this.syncOnce();
      const delay =
        this.failures === 0
          ? intervalMs
          : Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(this.failures, 6));
      this.timer = setTimeout(() => void tick(), delay);
    };
    void tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
