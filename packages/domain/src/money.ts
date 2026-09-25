import { invariant } from './errors';

/**
 * Money is an integer count of minor units (pesewas for GHS). Never a float.
 * Rounding rule for derived amounts: round half away from zero.
 */
export type Minor = number;

export function assertMinor(value: number, label = 'amount'): Minor {
  invariant(Number.isSafeInteger(value), `${label} must be an integer number of minor units`, { value });
  return value;
}

export function sum(values: readonly Minor[]): Minor {
  let total = 0;
  for (const v of values) total += v;
  return assertMinor(total, 'sum');
}

export function roundHalfAwayFromZero(value: number): Minor {
  const rounded = Math.sign(value) * Math.round(Math.abs(value));
  return rounded === 0 ? 0 : rounded;
}

/** amount × basisPoints / 10 000, rounded. */
export function percentOf(amount: Minor, basisPoints: number): Minor {
  return roundHalfAwayFromZero((amount * basisPoints) / 10_000);
}

export function formatMinor(amount: Minor, currency: string): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const major = Math.trunc(abs / 100);
  const minor = String(abs % 100).padStart(2, '0');
  return `${sign}${currency} ${major.toLocaleString('en-US')}.${minor}`;
}
