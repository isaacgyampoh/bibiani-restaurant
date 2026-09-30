import type { ApiErrorBody } from '@rp/contracts';
import { DomainError, type DomainErrorCode } from '@rp/domain';
import { InfrastructureError, InvalidTokenError } from '@rp/infrastructure';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const STATUS: Partial<Record<DomainErrorCode, ContentfulStatusCode>> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_MISMATCH: 409,
  VERSION_CONFLICT: 409,
  STALE_PRINT_CLAIM: 409,
  INVALID_TRANSITION: 409,
  TABLE_UNAVAILABLE: 409,
  ORDER_ALREADY_PAID: 409,
  ORDER_CLOSED: 409,
  PRODUCTION_STARTED: 409,
  PAYMENTS_RECORDED: 409,
  PAYMENT_REQUIRED_BEFORE_FULFILMENT: 409,
  PAIRING_CODE_INVALID: 400,
  UNAUTHENTICATED: 401,
  PIN_INVALID: 422,
  PIN_IN_USE: 409,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
  ORDER_NOT_MOVABLE: 409,
  CUSTOMER_EXISTS: 409,
  REGISTER_OPEN: 409,
  REGISTER_CLOSED: 409,
};

/** Messages shown to restaurant staff. Domain messages are already written for them; these override where needed. */
const OVERRIDES: Partial<Record<DomainErrorCode, string>> = {
  IDEMPOTENCY_MISMATCH: 'This request conflicts with an earlier one. Refresh and try again.',
  VERSION_CONFLICT: 'Someone else just updated this. The screen has been refreshed.',
  STALE_PRINT_CLAIM: 'This print job was already handled.',
};

/** What to tell staff when the server could not complete the operation (nothing was saved). */
export const OPERATION_FAILED: Record<string, string> = {
  submit_order: 'Unable to submit order. Please try again.',
  send_to_kitchen: 'Unable to send to the kitchen. Please try again.',
  record_payment: 'Payment was not recorded. Please try again.',
  void_payment: 'Payment was not voided. Please try again.',
  refund_payment: 'Refund was not recorded. Please try again.',
  ticket_action: 'Ticket was not updated. Please try again.',
  fulfil_order: 'Order was not updated. Please try again.',
  cancel_order: 'Order was not cancelled. Please try again.',
  void_items: 'Items were not voided. Please try again.',
  print_receipt: 'Receipt was not queued. Please try again.',
  pair_device: 'Pairing did not complete. Please try again.',
  save_config: 'Changes were not saved. Please try again.',
  save_photo: 'The photo was not saved. Please try again.',
  export_report: 'The report could not be exported. Please try again.',
  open_register: 'The register was not opened. Please try again.',
  close_register: 'The register was not closed. Please try again.',
  save_customer: 'The customer was not saved. Please try again.',
  save_staff: 'Staff changes were not saved. Please try again.',
  save_stock: 'Stock changes were not saved. Please try again.',
  stock_count: 'Stock count could not be saved. Please try again.',
  save_recipe: 'Recipe was not saved. Please try again.',
  default: 'Something went wrong. Please try again.',
};

/** A missing permission, named in staff words (the role can be changed in Staff, Roles & permissions). */
const PERMISSION_WORDS: Partial<Record<string, string>> = {
  'order.create': 'take orders',
  'order.send': 'send orders to the kitchen',
  'order.view': 'see orders',
  'order.fulfil': 'hand orders over',
  'order.cancel': 'cancel orders',
  'order.void': 'void items',
  'payment.record': 'take payments',
  'payment.void': 'void payments',
  'payment.refund': 'give refunds',
  'kitchen.operate': 'use the kitchen screen',
  'discount.apply': 'give discounts',
  'register.operate': 'use a cash register',
  'register.manage': 'manage cash registers',
  'reports.view': 'see reports',
  'menu.manage': 'change the menu',
  'config.manage': 'change settings',
  'device.manage': 'manage devices',
  'staff.manage': 'manage staff',
};

/**
 * Refusals are shown as they are (each is written for staff, e.g. "This branch is run by its
 * in-store hub..."); a bare permission refusal names the missing permission. Masking them all as
 * one sentence hid a blocked branch as a "permission" problem (production, 2026-09-30).
 */
function forbiddenMessage(error: DomainError): string {
  const permission = (error.details as { permission?: string } | undefined)?.permission;
  if (permission && error.message.startsWith('You do not have permission'))
    return `Your role does not allow you to ${PERMISSION_WORDS[permission] ?? 'do this'}. An owner can change this in Staff, Roles & permissions.`;
  return error.message.endsWith('.') ? error.message : `${error.message}.`;
}

export function toHttpError(
  error: unknown,
  operation: string,
  correlationId: string,
): { status: ContentfulStatusCode; body: ApiErrorBody; level: 'info' | 'warn' | 'error' } {
  const body = (code: string, message: string, retryable: boolean): ApiErrorBody => ({
    error: { code, message, correlationId, retryable },
  });
  if (error instanceof DomainError) {
    const status = STATUS[error.code] ?? 422;
    const message =
      error.code === 'FORBIDDEN' ? forbiddenMessage(error) : (OVERRIDES[error.code] ?? error.message);
    return { status, body: body(error.code, message, false), level: 'info' };
  }
  if (error instanceof InvalidTokenError) {
    return { status: 401, body: body('UNAUTHENTICATED', 'Please sign in again.', false), level: 'warn' };
  }
  const fallback = OPERATION_FAILED[operation] ?? OPERATION_FAILED.default!;
  if (error instanceof InfrastructureError && error.retryable) {
    return { status: 503, body: body('TEMPORARILY_UNAVAILABLE', fallback, true), level: 'warn' };
  }
  return { status: 500, body: body('INTERNAL', fallback, true), level: 'error' };
}
