import { invariant } from './errors';
import { type Minor, percentOf, roundHalfAwayFromZero } from './money';

export interface TaxRate {
  id: string;
  name: string;
  rateBp: number;
  isInclusive: boolean;
  isCompound: boolean;
  applyOrder: number;
}

export interface TaxLine {
  taxRateId: string;
  name: string;
  rateBp: number;
  isInclusive: boolean;
  amount: Minor;
}

export interface LineTaxResult {
  lines: TaxLine[];
  inclusiveTotal: Minor; // already contained in the gross amount
  exclusiveTotal: Minor; // added on top of the gross amount
}

/**
 * Taxes for one line whose gross price is `gross`.
 * - Inclusive taxes are extracted: net = gross / (1 + Σ inclusive rates); the
 *   rounding remainder goes to the last inclusive tax so parts sum exactly.
 * - Exclusive taxes apply to the net amount in `applyOrder`; compound taxes
 *   also apply to the exclusive taxes before them.
 */
export function calculateLineTaxes(gross: Minor, rates: readonly TaxRate[]): LineTaxResult {
  const ordered = [...rates].sort((a, b) => a.applyOrder - b.applyOrder || a.id.localeCompare(b.id));
  for (const r of ordered) {
    invariant(!(r.isInclusive && r.isCompound), 'Inclusive taxes cannot be compound', { taxRateId: r.id });
    invariant(Number.isInteger(r.rateBp) && r.rateBp >= 0, 'Invalid tax rate', { taxRateId: r.id });
  }

  const inclusive = ordered.filter((r) => r.isInclusive);
  const exclusive = ordered.filter((r) => !r.isInclusive);
  const lines: TaxLine[] = [];

  const inclusiveBp = inclusive.reduce((acc, r) => acc + r.rateBp, 0);
  const net = inclusiveBp === 0 ? gross : roundHalfAwayFromZero((gross * 10_000) / (10_000 + inclusiveBp));
  const inclusiveTotal = gross - net;
  let allocated = 0;
  inclusive.forEach((r, i) => {
    const amount =
      i === inclusive.length - 1
        ? inclusiveTotal - allocated
        : roundHalfAwayFromZero((net * r.rateBp) / 10_000);
    allocated += amount;
    lines.push({ taxRateId: r.id, name: r.name, rateBp: r.rateBp, isInclusive: true, amount });
  });

  let exclusiveTotal = 0;
  for (const r of exclusive) {
    const base = r.isCompound ? net + exclusiveTotal : net;
    const amount = percentOf(base, r.rateBp);
    exclusiveTotal += amount;
    lines.push({ taxRateId: r.id, name: r.name, rateBp: r.rateBp, isInclusive: false, amount });
  }

  return { lines, inclusiveTotal, exclusiveTotal };
}
