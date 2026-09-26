import { DomainError } from './errors';
import type { Minor } from './money';

/**
 * Promotions: automatic pricing rules applied when an item is added to an order. The result is
 * written onto the order line (snapshot), so later price or promotion changes never alter history.
 *
 * Rules (one consistent strategy everywhere):
 *  - A promotion discounts the product's BASE price (modifiers are always charged in full).
 *  - A line never costs less than zero: the discount is capped at base price × quantity.
 *  - Promotions never stack. When several are live for a line, the HIGHEST PRIORITY wins; at equal
 *    priority the one giving the LOWER price wins; then the older promotion. Two live promotions
 *    with the same priority covering the same items at the same time are refused when saved.
 *  - Receipts, kitchen screens and reports show: quantity × unit price = gross, the promotion
 *    name and its discount, and the net line total.
 */
export type PromotionKind = 'percent_off' | 'amount_off' | 'fixed_price' | 'bundle_price';

export interface Promotion {
  id: string;
  name: string;
  kind: PromotionKind;
  percentBp: number | null;
  amount: Minor | null;
  bundleQuantity: number | null;
  appliesToAll: boolean;
  productIds: readonly string[];
  categoryIds: readonly string[];
  branchId: string | null;
  startsOn: string | null; // YYYY-MM-DD (restaurant local)
  endsOn: string | null;
  daysOfWeek: readonly number[] | null; // 0 = Sunday
  startTime: string | null; // HH:MM
  endTime: string | null;
  priority: number;
  status: 'active' | 'paused';
  createdAt: string;
}

export interface AppliedPromotion {
  id: string;
  name: string;
  discount: Minor;
}

/** Validates a promotion before it is saved. Throws a clear message for impossible pricing. */
export function assertValidPromotion(p: Omit<Promotion, 'id' | 'createdAt'>): void {
  const fail = (message: string, field: string) => {
    throw new DomainError('VALIDATION_FAILED', message, { field });
  };
  if (!p.name.trim()) fail('Give the promotion a name', 'name');
  switch (p.kind) {
    case 'percent_off':
      if (p.percentBp === null || !Number.isInteger(p.percentBp) || p.percentBp < 1 || p.percentBp > 10_000)
        fail('A percentage discount is between 0.01% and 100%', 'percent');
      break;
    case 'amount_off':
      if (p.amount === null || p.amount <= 0) fail('Enter the amount to take off each item', 'amount');
      break;
    case 'fixed_price':
      if (p.amount === null || p.amount < 0)
        fail('Enter the promotional price (it cannot be negative)', 'amount');
      break;
    case 'bundle_price':
      if (p.bundleQuantity === null || p.bundleQuantity < 2 || p.bundleQuantity > 99)
        fail('A bundle is 2 to 99 items', 'bundleQuantity');
      if (p.amount === null || p.amount < 0) fail('Enter the bundle price (it cannot be negative)', 'amount');
      break;
  }
  if (!p.appliesToAll && p.productIds.length === 0 && p.categoryIds.length === 0)
    fail('Choose the products or categories this promotion applies to', 'targets');
  if (p.startsOn && p.endsOn && p.endsOn < p.startsOn)
    fail('The end date is before the start date', 'endsOn');
  if ((p.startTime === null) !== (p.endTime === null)) fail('Give both a start and an end time', 'startTime');
  if (p.startTime && p.endTime && p.startTime === p.endTime)
    fail('The start and end time are the same', 'endTime');
  if (p.daysOfWeek && p.daysOfWeek.length === 0) fail('Choose at least one day', 'daysOfWeek');
  if (!Number.isInteger(p.priority) || p.priority < 0 || p.priority > 100)
    fail('Priority is 0 to 100', 'priority');
}

/** Restaurant-local calendar facts for an instant. */
export function localMoment(instant: Date, timeZone: string): { date: string; day: number; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    day: days.indexOf(parts.weekday!),
    time: `${parts.hour}:${parts.minute}`,
  };
}

/** Is the promotion running at this moment (status, dates, days, daily window; windows may cross midnight)? */
export function isPromotionLive(p: Promotion, instant: Date, timeZone: string, branchId?: string): boolean {
  if (p.status !== 'active') return false;
  if (branchId && p.branchId && p.branchId !== branchId) return false;
  const m = localMoment(instant, timeZone);
  if (p.startsOn && m.date < p.startsOn) return false;
  if (p.endsOn && m.date > p.endsOn) return false;
  if (p.startTime && p.endTime) {
    const inWindow =
      p.startTime < p.endTime
        ? m.time >= p.startTime && m.time < p.endTime
        : m.time >= p.startTime || m.time < p.endTime;
    if (!inWindow) return false;
    // A window crossing midnight belongs to the day it started on.
    const day = p.startTime > p.endTime && m.time < p.endTime ? (m.day + 6) % 7 : m.day;
    if (p.daysOfWeek && !p.daysOfWeek.includes(day)) return false;
    return true;
  }
  if (p.daysOfWeek && !p.daysOfWeek.includes(m.day)) return false;
  return true;
}

export type PromotionPhase = 'live' | 'scheduled' | 'upcoming' | 'paused' | 'ended';
/** Where a promotion stands today: live now, runs today/other days (scheduled), starts later, paused or ended. */
export function promotionPhase(p: Promotion, instant: Date, timeZone: string): PromotionPhase {
  const m = localMoment(instant, timeZone);
  if (p.endsOn && m.date > p.endsOn) return 'ended';
  if (p.status === 'paused') return 'paused';
  if (p.startsOn && m.date < p.startsOn) return 'upcoming';
  return isPromotionLive(p, instant, timeZone) ? 'live' : 'scheduled';
}

/** Does the promotion cover this product (directly, by its category, or a parent category)? */
export function promotionCovers(
  p: Pick<Promotion, 'appliesToAll' | 'productIds' | 'categoryIds'>,
  productId: string,
  categoryPath: readonly string[],
): boolean {
  return (
    p.appliesToAll || p.productIds.includes(productId) || categoryPath.some((c) => p.categoryIds.includes(c))
  );
}

/** Discount a promotion gives on `quantity` units of a product whose base price is `basePrice`. */
export function promotionDiscount(p: Promotion, basePrice: Minor, quantity: number): Minor {
  const base = basePrice * quantity;
  let discount = 0;
  switch (p.kind) {
    case 'percent_off':
      discount = Math.round((base * (p.percentBp ?? 0)) / 10_000);
      break;
    case 'amount_off':
      discount = Math.min(p.amount ?? 0, basePrice) * quantity;
      break;
    case 'fixed_price':
      discount = Math.max(0, basePrice - (p.amount ?? basePrice)) * quantity;
      break;
    case 'bundle_price': {
      const n = p.bundleQuantity ?? 0;
      const bundles = n > 0 ? Math.floor(quantity / n) : 0;
      discount = bundles * Math.max(0, n * basePrice - (p.amount ?? n * basePrice));
      break;
    }
  }
  return Math.max(0, Math.min(discount, base));
}

/** The one promotion that applies to a line, by the explicit rule above (or null). */
export function choosePromotion(
  live: readonly Promotion[],
  line: { productId: string; categoryPath: readonly string[]; basePrice: Minor; quantity: number },
): AppliedPromotion | null {
  const candidates = live
    .filter((p) => promotionCovers(p, line.productId, line.categoryPath))
    .map((p) => ({ p, discount: promotionDiscount(p, line.basePrice, line.quantity) }))
    .filter((c) => c.discount > 0)
    .sort(
      (a, b) =>
        b.p.priority - a.p.priority ||
        b.discount - a.discount ||
        a.p.createdAt.localeCompare(b.p.createdAt) ||
        a.p.id.localeCompare(b.p.id),
    );
  const best = candidates[0];
  return best ? { id: best.p.id, name: best.p.name, discount: best.discount } : null;
}

/**
 * Two promotions conflict when they could both be live at the same moment, cover a common item,
 * and have the same priority (the result would depend on discount size, which is surprising for
 * staff). Ancestry is resolved by the caller into `categoryPaths` (product -> category path).
 */
export function promotionsConflict(
  a: Promotion,
  b: Promotion,
  productCategoryPaths: ReadonlyMap<string, readonly string[]>,
): boolean {
  if (a.id === b.id || a.priority !== b.priority) return false;
  if (a.status !== 'active' || b.status !== 'active') return false;
  if (a.branchId && b.branchId && a.branchId !== b.branchId) return false;
  const aStart = a.startsOn ?? '0000-01-01';
  const aEnd = a.endsOn ?? '9999-12-31';
  const bStart = b.startsOn ?? '0000-01-01';
  const bEnd = b.endsOn ?? '9999-12-31';
  if (aEnd < bStart || bEnd < aStart) return false;
  if (a.daysOfWeek && b.daysOfWeek && !a.daysOfWeek.some((d) => b.daysOfWeek!.includes(d))) return false;
  if (a.startTime && a.endTime && b.startTime && b.endTime) {
    const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const ranges = (s: string, e: string): [number, number][] =>
      minutes(s) < minutes(e)
        ? [[minutes(s), minutes(e)]]
        : [
            [minutes(s), 1440],
            [0, minutes(e)],
          ];
    const overlap = ranges(a.startTime, a.endTime).some(([s1, e1]) =>
      ranges(b.startTime!, b.endTime!).some(([s2, e2]) => s1 < e2 && s2 < e1),
    );
    if (!overlap) return false;
  }
  for (const [productId, path] of productCategoryPaths) {
    if (promotionCovers(a, productId, path) && promotionCovers(b, productId, path)) return true;
  }
  return false;
}

/**
 * A manager discount spread over the lines it applies to, in proportion to each line's current net
 * amount (largest remainder, so parts add up exactly). Never takes a line below zero.
 */
export function allocateDiscount(total: Minor, lines: { id: string; net: Minor }[]): Map<string, Minor> {
  const base = lines.reduce((a, l) => a + l.net, 0);
  const out = new Map<string, Minor>();
  if (total <= 0 || base <= 0) return out;
  const capped = Math.min(total, base);
  const raw = lines.map((l) => ({ id: l.id, exact: (capped * l.net) / base }));
  let given = 0;
  for (const r of raw) {
    const share = Math.floor(r.exact);
    out.set(r.id, share);
    given += share;
  }
  const order = [...raw].sort((x, y) => (y.exact % 1) - (x.exact % 1) || x.id.localeCompare(y.id));
  for (let i = 0; given < capped; i++, given++) {
    const id = order[i % order.length]!.id;
    out.set(id, out.get(id)! + 1);
  }
  return out;
}
