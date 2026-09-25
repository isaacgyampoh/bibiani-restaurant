import { createHash, randomUUID } from 'node:crypto';
import type { Clock, Fingerprinter, IdGenerator, LogFields, Logger } from '@rp/application';

export const systemClock: Clock = { now: () => new Date() };

export const randomIds: IdGenerator = { uuid: () => randomUUID() };

/** SHA-256 over canonical JSON (object keys sorted), so equal commands always hash equally. */
export const sha256Fingerprinter: Fingerprinter = {
  of(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value)).digest('hex');
  },
};

export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Structured JSON lines on stdout/stderr: one event per line, correlation ids included by callers. */
export function createJsonLogger(
  base: LogFields = {},
  write: (line: string, level: string) => void = (line, level) =>
    level === 'error' ? process.stderr.write(`${line}\n`) : process.stdout.write(`${line}\n`),
): Logger {
  const emit = (level: string, event: string, fields?: LogFields) =>
    write(
      JSON.stringify({ ts: new Date().toISOString(), level, event, ...base, ...fields }, errorReplacer),
      level,
    );
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    const cause = (value as Error & { cause?: unknown }).cause;
    return {
      name: value.name,
      message: value.message,
      cause: cause instanceof Error ? cause.message : cause,
    };
  }
  return value;
}
