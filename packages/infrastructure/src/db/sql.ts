/** Minimal SQL surface the repositories need. Implemented for postgres.js (production) and PGlite (tests). */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface Database extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Postgres drivers disagree on int8 (string vs number vs bigint). Money columns always pass through here. */
export function num(value: unknown): number {
  if (value === null || value === undefined) throw new Error('Expected a numeric value');
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Unsafe integer from database: ${String(value)}`);
  return n;
}

export function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

export function dateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(String(value));
}
