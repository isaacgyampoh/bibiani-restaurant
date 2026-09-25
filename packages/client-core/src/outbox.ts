import { ApiError } from './api-client';

/**
 * Durable queue of write operations. Each operation carries the ids the server
 * uses for idempotency (order id, submission id, payment id), so replaying an
 * operation that actually succeeded before the connection dropped is harmless.
 * Operations are NEVER dropped automatically: permanent failures are kept and
 * flagged for a person to resolve.
 */
export interface OutboxEntry<P = unknown> {
  id: string;
  /** Operations sharing a key run strictly in order (e.g. all writes for one order). */
  key: string;
  kind: string;
  payload: P;
  state: 'pending' | 'needs_attention';
  attempts: number;
  lastError: string | null;
  enqueuedAt: string;
}

/** Persistence port. The web app implements it with IndexedDB; tests use memory. */
export interface OutboxStore {
  load(): Promise<OutboxEntry[]>;
  put(entry: OutboxEntry): Promise<void>;
  remove(id: string): Promise<void>;
}

export class MemoryOutboxStore implements OutboxStore {
  readonly entries = new Map<string, OutboxEntry>();
  async load() {
    return [...this.entries.values()];
  }
  async put(entry: OutboxEntry) {
    this.entries.set(entry.id, structuredClone(entry));
  }
  async remove(id: string) {
    this.entries.delete(id);
  }
}

export type OutboxHandler = (entry: OutboxEntry) => Promise<unknown>;

export interface FlushResult {
  sent: string[];
  waiting: string[];
  needsAttention: string[];
}

export class Outbox {
  private flushing: Promise<FlushResult> | null = null;

  constructor(
    private readonly store: OutboxStore,
    private readonly handlers: Record<string, OutboxHandler>,
  ) {}

  async enqueue<P>(entry: { id: string; key: string; kind: string; payload: P }): Promise<void> {
    if (!this.handlers[entry.kind]) throw new Error(`No outbox handler for ${entry.kind}`);
    await this.store.put({
      ...entry,
      state: 'pending',
      attempts: 0,
      lastError: null,
      enqueuedAt: new Date().toISOString(),
    });
  }

  async pending(): Promise<OutboxEntry[]> {
    return (await this.store.load()).sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
  }

  /** Sends everything it can. Call on startup, on reconnect and after each enqueue. */
  flush(): Promise<FlushResult> {
    this.flushing ??= this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<FlushResult> {
    const result: FlushResult = { sent: [], waiting: [], needsAttention: [] };
    const blockedKeys = new Set<string>();
    for (const entry of await this.pending()) {
      if (entry.state === 'needs_attention' || blockedKeys.has(entry.key)) {
        blockedKeys.add(entry.key);
        (entry.state === 'needs_attention' ? result.needsAttention : result.waiting).push(entry.id);
        continue;
      }
      try {
        await this.handlers[entry.kind]!(entry);
        await this.store.remove(entry.id);
        result.sent.push(entry.id);
      } catch (error) {
        const retryable = error instanceof ApiError ? error.retryable : true;
        const updated: OutboxEntry = {
          ...entry,
          attempts: entry.attempts + 1,
          lastError: error instanceof Error ? error.message : String(error),
          state: retryable ? 'pending' : 'needs_attention',
        };
        await this.store.put(updated);
        blockedKeys.add(entry.key); // keep per-order ordering: later writes wait
        (retryable ? result.waiting : result.needsAttention).push(entry.id);
      }
    }
    return result;
  }
}
