/**
 * Business-rule violations. `code` is stable and machine-readable; the
 * presentation layer maps it to operator-facing wording. `details` carries
 * diagnostics for logs and must never be shown verbatim to restaurant staff.
 */
export const DOMAIN_ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'FORBIDDEN',
  'IDEMPOTENCY_MISMATCH',
  'VERSION_CONFLICT',
  'INVALID_TRANSITION',
  'PRODUCT_UNAVAILABLE',
  'TABLE_REQUIRED',
  'TABLE_UNAVAILABLE',
  'CUSTOMER_NAME_REQUIRED',
  'NOTHING_TO_SEND',
  'NO_ROUTE',
  'PAYMENT_REQUIRED_BEFORE_PRODUCTION',
  'PAYMENT_EXCEEDS_BALANCE',
  'ORDER_ALREADY_PAID',
  'ORDER_CLOSED',
  'NOTHING_TO_FULFIL',
  'REFUND_EXCEEDS_PAYMENT',
  'STALE_PRINT_CLAIM',
  'PAYMENT_REQUIRED_BEFORE_FULFILMENT',
  'PRODUCTION_STARTED',
  'PAYMENTS_RECORDED',
  'NOTHING_TO_VOID',
  'PAIRING_CODE_INVALID',
  'UNAUTHENTICATED',
] as const;
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function invariant(
  condition: unknown,
  message: string,
  details?: Record<string, unknown>,
): asserts condition {
  if (!condition) throw new DomainError('VALIDATION_FAILED', message, details);
}
