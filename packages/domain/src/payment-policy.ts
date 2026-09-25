import type { PaymentPolicy, PaymentStatus } from './enums';
import { DomainError } from './errors';

const SETTLED: ReadonlySet<PaymentStatus> = new Set(['paid', 'partially_refunded', 'refunded']);

export function isSettled(status: PaymentStatus): boolean {
  return SETTLED.has(status);
}

/** Handing food over is governed by the area's payment policy, not hard-coded per channel. */
export function assertFulfilmentAllowed(policy: PaymentPolicy, paymentStatus: PaymentStatus): void {
  if (policy === 'pay_before_fulfillment' && !isSettled(paymentStatus)) {
    throw new DomainError(
      'PAYMENT_REQUIRED_BEFORE_FULFILMENT',
      'Take full payment before handing this order over',
      {
        paymentStatus,
      },
    );
  }
}
