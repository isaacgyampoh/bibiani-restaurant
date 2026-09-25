import type { PaymentDirection, PaymentMethod, PaymentRecordStatus, PaymentStatus } from './enums';
import { DomainError, invariant } from './errors';
import { assertMinor, type Minor, sum } from './money';

/**
 * V1 payments are manual records of money the cashier has verified (cash in the
 * drawer, MoMo on the customer's phone, card terminal slip). No provider calls.
 */
export interface PaymentRecord {
  id: string;
  direction: PaymentDirection;
  method: PaymentMethod;
  amount: Minor;
  status: PaymentRecordStatus;
  refundOfPaymentId: string | null;
}

export interface PaymentTotals {
  paidTotal: Minor;
  refundedTotal: Minor;
}

export function summarizePayments(records: readonly PaymentRecord[]): PaymentTotals {
  const live = records.filter((r) => r.status === 'recorded');
  return {
    paidTotal: sum(live.filter((r) => r.direction === 'charge').map((r) => r.amount)),
    refundedTotal: sum(live.filter((r) => r.direction === 'refund').map((r) => r.amount)),
  };
}

export function derivePaymentStatus(
  grandTotal: Minor,
  totals: PaymentTotals,
  hasActiveItems: boolean,
): PaymentStatus {
  const net = totals.paidTotal - totals.refundedTotal;
  if (totals.refundedTotal > 0) return net === 0 ? 'refunded' : 'partially_refunded';
  if (totals.paidTotal === 0) return grandTotal === 0 && hasActiveItems ? 'paid' : 'unpaid';
  return net >= grandTotal ? 'paid' : 'partially_paid';
}

export function balanceDue(grandTotal: Minor, totals: PaymentTotals): Minor {
  return Math.max(0, grandTotal - (totals.paidTotal - totals.refundedTotal));
}

export interface PaymentRequest {
  method: PaymentMethod;
  /** Amount to apply to the order. For cash it may be omitted when `tendered` is given. */
  amount?: Minor | null;
  /** Cash handed over by the customer (cash only). */
  tendered?: Minor | null;
}

export interface PlannedPayment {
  amount: Minor;
  tendered: Minor | null;
  change: Minor;
}

/**
 * Validates one manual payment against the balance due. Split payments are
 * simply several calls. Only cash may exceed the balance, and the excess is change.
 */
export function planPayment(balance: Minor, request: PaymentRequest): PlannedPayment {
  if (balance <= 0) throw new DomainError('ORDER_ALREADY_PAID', 'This order is already fully paid');

  if (request.method === 'cash') {
    const tendered = request.tendered ?? request.amount ?? null;
    invariant(tendered !== null, 'Enter the cash amount received');
    assertMinor(tendered, 'tendered');
    invariant(tendered > 0, 'Cash received must be more than zero');
    const amount = request.amount ?? Math.min(tendered, balance);
    assertMinor(amount);
    invariant(amount > 0, 'Payment amount must be more than zero');
    invariant(amount <= tendered, 'Amount applied cannot exceed cash received', { amount, tendered });
    if (amount > balance) {
      throw new DomainError('PAYMENT_EXCEEDS_BALANCE', 'Payment is more than the balance due', {
        amount,
        balance,
      });
    }
    return { amount, tendered, change: tendered - amount };
  }

  invariant(request.tendered == null, 'Cash tendered only applies to cash payments');
  invariant(request.amount != null, 'Enter the payment amount');
  const amount = assertMinor(request.amount);
  invariant(amount > 0, 'Payment amount must be more than zero');
  if (amount > balance) {
    throw new DomainError('PAYMENT_EXCEEDS_BALANCE', 'Payment is more than the balance due', {
      amount,
      balance,
    });
  }
  return { amount, tendered: null, change: 0 };
}

export function planRefund(original: PaymentRecord, alreadyRefunded: Minor, amount: Minor): Minor {
  invariant(original.direction === 'charge', 'Only payments can be refunded');
  invariant(original.status === 'recorded', 'A voided payment cannot be refunded');
  assertMinor(amount);
  invariant(amount > 0, 'Refund amount must be more than zero');
  if (amount > original.amount - alreadyRefunded) {
    throw new DomainError('REFUND_EXCEEDS_PAYMENT', 'Refund is more than the remaining payment', {
      amount,
      refundable: original.amount - alreadyRefunded,
    });
  }
  return amount;
}
