import postgres from 'postgres';
import { currentRequestMetrics } from '../system/request-metrics';
import type { Database, Sql } from './sql';

/**
 * Production driver. Intended for the Supabase pooler in transaction mode,
 * which requires prepared statements to be disabled.
 */
export function createPostgresDatabase(
  url: string,
  options: { max?: number; onNotice?: (notice: postgres.Notice) => void } = {},
): Database {
  const client = postgres(url, {
    prepare: false,
    max: options.max ?? 5,
    idle_timeout: 20,
    connect_timeout: 10,
    // Server notices (e.g. a dropped realtime broadcast) become structured warnings, not raw console output.
    onnotice:
      options.onNotice ??
      ((n) => {
        if (n.severity === 'WARNING') {
          const line = {
            ts: new Date().toISOString(),
            level: 'warn',
            event: 'db.notice',
            message: n.message,
          };
          process.stderr.write(`${JSON.stringify(line)}\n`);
        }
      }),
  });
  const wrap = (runner: postgres.Sql | postgres.TransactionSql): Sql => ({
    query: async <T>(text: string, params: readonly unknown[] = []) => {
      const started = performance.now();
      try {
        return (await runner.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as unknown as T[];
      } finally {
        const m = currentRequestMetrics();
        if (m) {
          m.statements += 1;
          m.dbMs += performance.now() - started;
        }
      }
    },
  });
  const root = wrap(client);
  return {
    query: root.query,
    transaction: async <T>(fn: (tx: Sql) => Promise<T>) => {
      const m = currentRequestMetrics();
      if (m) m.transactions += 1;
      return (await client.begin((tx) => fn(wrap(tx)))) as T;
    },
    close: () => client.end({ timeout: 5 }),
  };
}
