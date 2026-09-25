import { DomainError } from '@rp/domain';

/** Arrays/objects travel as one JSON parameter so every driver sends them identically. */
export const json = (value: unknown): string => JSON.stringify(value);

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

const toSnake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Builds "col = $n" assignments from a patch object, skipping undefined values. */
export function assignments(
  patch: Record<string, unknown>,
  startIndex: number,
): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    params.push(value instanceof Date ? value.toISOString() : value);
    parts.push(`${toSnake(key)} = $${startIndex + params.length - 1}`);
  }
  return { sql: parts.join(', '), params };
}

/** Errors from infrastructure that are not business-rule violations. */
export class InfrastructureError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InfrastructureError';
    this.retryable = retryable;
  }
}

interface PgLikeError {
  code?: string;
  constraint?: string;
  constraint_name?: string;
  message?: string;
}

const RETRY_IN_PLACE = new Set(['40001', '40P01']); // serialization failure, deadlock

/** Database unreachable / overloaded / restarting: the request did nothing and can be retried. */
const UNAVAILABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  '53300',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
]);

export function isRetryableInPlace(error: unknown): boolean {
  return RETRY_IN_PLACE.has((error as PgLikeError)?.code ?? '');
}

/** Maps Postgres errors to domain or infrastructure errors. Raw database messages never reach users. */
export function translatePgError(error: unknown): unknown {
  if (error instanceof DomainError || error instanceof InfrastructureError) return error;
  const e = error as PgLikeError;
  const constraint = e?.constraint_name ?? e?.constraint ?? '';
  switch (e?.code) {
    case '23505':
      if (constraint === 'orders_one_active_per_table') {
        return new DomainError('TABLE_UNAVAILABLE', 'This table already has an open order', { constraint });
      }
      if (
        ['order_items_pkey', 'payments_pkey', 'order_submissions_pkey', 'orders_pkey'].includes(constraint)
      ) {
        return new DomainError('IDEMPOTENCY_MISMATCH', 'This id was already used for something else', {
          constraint,
        });
      }
      return new InfrastructureError(`Unique constraint violated: ${constraint}`, true, { cause: error });
    case '23503':
      return new DomainError('VALIDATION_FAILED', 'A referenced record does not exist', { constraint });
    case '42501':
      return new DomainError('FORBIDDEN', 'You do not have permission to do this', {
        reason: 'row level security',
      });
    case '55P03':
    case '57014':
      return new InfrastructureError('Database busy (lock or statement timeout)', true, { cause: error });
    case '40001':
    case '40P01':
      return new InfrastructureError('Database conflict', true, { cause: error });
    default:
      if (UNAVAILABLE.has(e?.code ?? '')) {
        return new InfrastructureError('Database unavailable', true, { cause: error });
      }
      return new InfrastructureError('Unexpected database error', false, { cause: error });
  }
}
