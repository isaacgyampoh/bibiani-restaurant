import { assertMinor, type Minor } from './money';

/** One payment as the register sees it (recorded ones only; voided payments never count). */
export interface RegisterPayment {
  method: 'cash' | 'momo' | 'card';
  direction: 'charge' | 'refund';
  amount: Minor;
}

export interface RegisterTotals {
  cashSales: Minor;
  cashRefunds: Minor;
  /** Opening float + cash taken − cash refunded: what should be in the drawer. */
  expectedCash: Minor;
  byMethod: { method: 'cash' | 'momo' | 'card'; charges: Minor; refunds: Minor; net: Minor; count: number }[];
  totalNet: Minor;
}

/**
 * Expected drawer cash for a register session. Change given is not a separate movement: a cash
 * payment's `amount` is what was applied to the order (tendered − change), so it is what stays
 * in the drawer.
 */
export function registerTotals(openingCash: Minor, payments: readonly RegisterPayment[]): RegisterTotals {
  assertMinor(openingCash, 'opening cash');
  const byMethod = (['cash', 'momo', 'card'] as const).map((method) => {
    const mine = payments.filter((p) => p.method === method);
    const charges = mine.filter((p) => p.direction === 'charge').reduce((n, p) => n + p.amount, 0);
    const refunds = mine.filter((p) => p.direction === 'refund').reduce((n, p) => n + p.amount, 0);
    return {
      method,
      charges,
      refunds,
      net: charges - refunds,
      count: mine.filter((p) => p.direction === 'charge').length,
    };
  });
  const cash = byMethod[0]!;
  return {
    cashSales: cash.charges,
    cashRefunds: cash.refunds,
    expectedCash: openingCash + cash.charges - cash.refunds,
    byMethod,
    totalNet: byMethod.reduce((n, m) => n + m.net, 0),
  };
}

/** Counted − expected: negative means cash is missing, positive means there is extra cash. */
export function registerVariance(expectedCash: Minor, countedCash: Minor): Minor {
  return assertMinor(countedCash, 'counted cash') - expectedCash;
}
