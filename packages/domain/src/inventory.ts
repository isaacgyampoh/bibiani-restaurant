import type { StockMovementKind } from './enums';
import { DomainError } from './errors';

/**
 * Inventory rules. Quantities are integers in THOUSANDTHS of the item's unit ("milli": 1.5 kg = 1500),
 * so arithmetic is exact; the database stores numeric(14,3) and the repository converts.
 */
export type Milli = number;

export const toMilli = (quantity: number): Milli => Math.round(quantity * 1000);
export const fromMilli = (milli: Milli): number => milli / 1000;

export interface StockLevel {
  quantity: Milli;
  minQuantity: Milli;
}

export const isLowStock = (item: StockLevel): boolean => item.quantity <= item.minQuantity;

/** Stock value in minor currency units (unit cost is per whole unit). */
export const stockValue = (quantity: Milli, unitCost: number): number =>
  Math.max(0, Math.round((quantity * unitCost) / 1000));

export type ManualMovementKind = Extract<StockMovementKind, 'receive' | 'waste' | 'adjust'>;

/**
 * A manual stock movement, as entered by staff:
 *  - receive: a positive quantity arriving (delivery);
 *  - waste: a positive quantity lost (spoiled, dropped); cannot take stock below zero;
 *  - adjust: a signed correction with a reason; cannot take stock below zero.
 * Returns the signed delta to apply.
 */
export function planManualMovement(
  kind: ManualMovementKind,
  current: Milli,
  quantity: Milli,
  reason: string | null | undefined,
): { delta: Milli; after: Milli } {
  if (!Number.isInteger(quantity) || quantity === 0)
    throw new DomainError('VALIDATION_FAILED', 'Enter a quantity');
  const trimmed = reason?.trim() ?? '';
  let delta: Milli;
  if (kind === 'receive') {
    if (quantity < 0) throw new DomainError('VALIDATION_FAILED', 'A delivery quantity must be positive');
    delta = quantity;
  } else if (kind === 'waste') {
    if (quantity < 0) throw new DomainError('VALIDATION_FAILED', 'A wastage quantity must be positive');
    if (!trimmed) throw new DomainError('VALIDATION_FAILED', 'Say why the stock was wasted');
    delta = -quantity;
  } else {
    if (!trimmed) throw new DomainError('VALIDATION_FAILED', 'Give a reason for the adjustment');
    delta = quantity;
  }
  const after = current + delta;
  if (after < 0)
    throw new DomainError('VALIDATION_FAILED', `Only ${fromMilli(current)} in stock`, {
      inStock: fromMilli(current),
    });
  return { delta, after };
}

export interface CountLine {
  itemId: string;
  systemQuantity: Milli;
  countedQuantity: Milli | null;
  reason: string | null;
}

/**
 * Approving a stock count: every counted line whose count differs from the CURRENT system quantity
 * becomes one 'count' movement. A variance needs a reason. Uncounted lines change nothing.
 */
export function planCountApproval(
  lines: CountLine[],
  currentQuantity: (itemId: string) => Milli,
): { itemId: string; delta: Milli; after: Milli; reason: string }[] {
  const counted = lines.filter((l) => l.countedQuantity !== null);
  if (counted.length === 0) throw new DomainError('VALIDATION_FAILED', 'Nothing has been counted yet');
  const out: { itemId: string; delta: Milli; after: Milli; reason: string }[] = [];
  for (const line of counted) {
    const current = currentQuantity(line.itemId);
    const delta = line.countedQuantity! - current;
    if (delta === 0) continue;
    const reason = line.reason?.trim();
    if (!reason)
      throw new DomainError('VALIDATION_FAILED', 'Every difference needs a reason', { itemId: line.itemId });
    out.push({ itemId: line.itemId, delta, after: line.countedQuantity!, reason });
  }
  return out;
}

/** Stock a sale consumes: recipe quantity per unit × units sold, summed per inventory item. */
export function planSaleConsumption(
  lines: { productId: string; quantity: number }[],
  recipes: Map<string, { itemId: string; quantity: Milli }[]>,
): Map<string, Milli> {
  const use = new Map<string, Milli>();
  for (const line of lines) {
    for (const c of recipes.get(line.productId) ?? []) {
      use.set(c.itemId, (use.get(c.itemId) ?? 0) + c.quantity * line.quantity);
    }
  }
  return use;
}
