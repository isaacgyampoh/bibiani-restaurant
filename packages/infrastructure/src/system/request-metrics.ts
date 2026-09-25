import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request database metrics (time in the database, statements, transactions), for Server-Timing and logs. */
export interface RequestMetrics {
  dbMs: number;
  statements: number;
  transactions: number;
}

const storage = new AsyncLocalStorage<RequestMetrics>();

export function withRequestMetrics<T>(fn: () => Promise<T>): Promise<{ result: T; metrics: RequestMetrics }> {
  const metrics: RequestMetrics = { dbMs: 0, statements: 0, transactions: 0 };
  return storage.run(metrics, async () => ({ result: await fn(), metrics }));
}

export function currentRequestMetrics(): RequestMetrics | undefined {
  return storage.getStore();
}
