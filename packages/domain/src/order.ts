import type { OrderChannel, OrderItemStatus, OrderStatus, PaymentStatus } from './enums';
import { DomainError, invariant } from './errors';
import { assertMinor, type Minor, sum } from './money';
import { isSettled } from './payment-policy';
import { groupByStation, type RouteDecision, type RoutingConfig, resolveRoute } from './routing';
import { calculateLineTaxes, type TaxLine, type TaxRate } from './tax';

// ---------------------------------------------------------------------------
// Catalog view used when selling (prices already resolved for the branch)
// ---------------------------------------------------------------------------
export interface ModifierForSale {
  id: string;
  name: string;
  priceDelta: Minor;
}

export interface ModifierGroupForSale {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number | null;
  modifiers: readonly ModifierForSale[];
}

export interface ProductForSale {
  id: string;
  categoryId: string;
  name: string;
  kitchenName: string | null;
  price: Minor;
  isAvailable: boolean;
  requiresPreparation: boolean;
  taxes: readonly TaxRate[];
  modifierGroups: readonly ModifierGroupForSale[];
}

// ---------------------------------------------------------------------------
// Order aggregate
// ---------------------------------------------------------------------------
export interface OrderItemModifier {
  modifierId: string;
  name: string;
  priceDelta: Minor;
}

export interface OrderItem {
  id: string;
  productId: string;
  categoryId: string;
  name: string;
  kitchenName: string | null;
  unitPrice: Minor;
  quantity: number;
  modifiers: OrderItemModifier[];
  modifiersTotal: Minor;
  lineTotal: Minor;
  taxLines: TaxLine[];
  taxTotal: Minor;
  notes: string | null;
  requiresPreparation: boolean;
  stationId: string | null;
  submissionId: string | null;
  status: OrderItemStatus;
}

export interface OrderTotals {
  subtotal: Minor;
  taxTotal: Minor;
  grandTotal: Minor;
}

export const ACTIVE_ITEM = (i: Pick<OrderItem, 'status'>) =>
  i.status !== 'cancelled' && i.status !== 'voided';
export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'completed',
  'cancelled',
  'voided',
]);

export interface NewItemInput {
  id: string;
  productId: string;
  quantity: number;
  modifierIds: readonly string[];
  notes: string | null;
}

/** Prices a new line from the catalog. Validates availability, quantity and modifier rules. */
export function priceNewItem(input: NewItemInput, product: ProductForSale): OrderItem {
  invariant(
    Number.isInteger(input.quantity) && input.quantity > 0 && input.quantity <= 999,
    'Invalid quantity',
    {
      itemId: input.id,
      quantity: input.quantity,
    },
  );
  if (!product.isAvailable) {
    throw new DomainError('PRODUCT_UNAVAILABLE', `${product.name} is not available`, {
      productId: product.id,
    });
  }

  const byId = new Map<string, { group: ModifierGroupForSale; modifier: ModifierForSale }>();
  for (const group of product.modifierGroups) {
    for (const modifier of group.modifiers) byId.set(modifier.id, { group, modifier });
  }
  invariant(new Set(input.modifierIds).size === input.modifierIds.length, 'Duplicate modifier selection', {
    itemId: input.id,
  });
  const selected = input.modifierIds.map((id) => {
    const found = byId.get(id);
    invariant(found, 'Modifier does not belong to this product', { itemId: input.id, modifierId: id });
    return found;
  });
  for (const group of product.modifierGroups) {
    const count = selected.filter((s) => s.group.id === group.id).length;
    invariant(count >= group.minSelect, `Choose at least ${group.minSelect} from ${group.name}`, {
      itemId: input.id,
      groupId: group.id,
    });
    invariant(
      group.maxSelect === null || count <= group.maxSelect,
      `Choose at most ${group.maxSelect} from ${group.name}`,
      {
        itemId: input.id,
        groupId: group.id,
      },
    );
  }

  const modifiers = selected.map(({ modifier }) => ({
    modifierId: modifier.id,
    name: modifier.name,
    priceDelta: modifier.priceDelta,
  }));
  const modifiersTotal = sum(modifiers.map((m) => m.priceDelta));
  const unitGross = assertMinor(product.price + modifiersTotal, 'unit price');
  invariant(unitGross >= 0, 'Line price cannot be negative', { itemId: input.id });
  const lineTotal = assertMinor(unitGross * input.quantity, 'line total');
  const taxes = calculateLineTaxes(lineTotal, product.taxes);

  return {
    id: input.id,
    productId: product.id,
    categoryId: product.categoryId,
    name: product.name,
    kitchenName: product.kitchenName,
    unitPrice: product.price,
    quantity: input.quantity,
    modifiers,
    modifiersTotal,
    lineTotal,
    taxLines: taxes.lines,
    taxTotal: taxes.inclusiveTotal + taxes.exclusiveTotal,
    notes: input.notes?.trim() || null,
    requiresPreparation: product.requiresPreparation,
    stationId: null,
    submissionId: null,
    status: 'pending',
  };
}

/** Same client item id sent again: must describe the same line, otherwise it is a different operation. */
export function sameItemRequest(existing: OrderItem, input: NewItemInput): boolean {
  return (
    existing.productId === input.productId &&
    existing.quantity === input.quantity &&
    (existing.notes ?? null) === (input.notes?.trim() || null) &&
    [...existing.modifiers.map((m) => m.modifierId)].sort().join(',') ===
      [...input.modifierIds].sort().join(',')
  );
}

export function computeTotals(items: readonly OrderItem[]): OrderTotals {
  const active = items.filter(ACTIVE_ITEM);
  const subtotal = sum(active.map((i) => i.lineTotal));
  const exclusive = sum(active.flatMap((i) => i.taxLines.filter((t) => !t.isInclusive).map((t) => t.amount)));
  const taxTotal = sum(active.map((i) => i.taxTotal));
  return { subtotal, taxTotal, grandTotal: subtotal + exclusive };
}

/**
 * Fulfilment status derived from item states (plus payment for completion).
 * Nothing outside this function decides an order's status.
 */
export function deriveOrderStatus(
  current: OrderStatus,
  channel: OrderChannel,
  items: readonly Pick<OrderItem, 'status'>[],
  paymentStatus: PaymentStatus,
): OrderStatus {
  if (current === 'cancelled' || current === 'voided') return current;

  // Everything removed: voided if anything had reached production, otherwise cancelled.
  if (items.length > 0 && !items.some(ACTIVE_ITEM)) {
    return items.some((i) => i.status === 'voided') ? 'voided' : 'cancelled';
  }

  const sent = items.filter(ACTIVE_ITEM).filter((i) => i.status !== 'pending');
  if (sent.length === 0) return 'draft';

  const is =
    (...statuses: OrderItemStatus[]) =>
    (i: Pick<OrderItem, 'status'>) =>
      statuses.includes(i.status);

  if (sent.every(is('served'))) {
    const fulfilled: OrderStatus = channel === 'dine_in' ? 'served' : 'picked_up';
    // Refunds happen after settlement, so a refunded order stays completed.
    return isSettled(paymentStatus) ? 'completed' : fulfilled;
  }
  if (sent.every(is('ready', 'served'))) return 'ready';
  if (sent.some(is('ready', 'served'))) return 'partially_ready';
  if (sent.some(is('in_preparation'))) return 'in_preparation';
  return 'submitted';
}

// ---------------------------------------------------------------------------
// Sending to production
// ---------------------------------------------------------------------------
export interface StationInfo {
  id: string;
  autoReady: boolean;
}

export interface PlannedTicket {
  stationId: string;
  itemIds: string[];
  /** Ticket starts 'ready' when every item on it needs no preparation. */
  initiallyReady: boolean;
  decisions: RouteDecision[];
}

export interface SubmissionPlan {
  tickets: PlannedTicket[];
  itemUpdates: { itemId: string; stationId: string; status: OrderItemStatus }[];
}

/**
 * Routes every pending item and groups them into one ticket per station.
 * Pure: the caller persists the plan inside one transaction.
 */
export function planSubmission(
  items: readonly OrderItem[],
  areaId: string,
  routing: RoutingConfig,
  stations: ReadonlyMap<string, StationInfo>,
): SubmissionPlan {
  const pending = items.filter((i) => i.status === 'pending');
  if (pending.length === 0) throw new DomainError('NOTHING_TO_SEND', 'There are no new items to send');

  const decisions = pending.map((i) =>
    resolveRoute({ itemId: i.id, productId: i.productId, categoryId: i.categoryId }, areaId, routing),
  );
  const byId = new Map(pending.map((i) => [i.id, i]));
  const itemUpdates = decisions.map((d) => {
    const item = byId.get(d.itemId)!;
    const autoReady = !item.requiresPreparation || stations.get(d.stationId)?.autoReady === true;
    return {
      itemId: d.itemId,
      stationId: d.stationId,
      status: (autoReady ? 'ready' : 'sent') as OrderItemStatus,
    };
  });
  const statusById = new Map(itemUpdates.map((u) => [u.itemId, u.status]));

  const tickets = [...groupByStation(decisions)].map(([stationId, group]) => ({
    stationId,
    itemIds: group.map((d) => d.itemId),
    initiallyReady: group.every((d) => statusById.get(d.itemId) === 'ready'),
    decisions: group,
  }));
  return { tickets, itemUpdates };
}

/** Items that become 'served' when staff hand the order over. */
export function planFulfilment(items: readonly OrderItem[], itemIds?: readonly string[]): string[] {
  const wanted = itemIds ? new Set(itemIds) : null;
  const ready = items.filter((i) => i.status === 'ready' && (!wanted || wanted.has(i.id)));
  if (wanted) {
    for (const id of wanted) {
      invariant(
        ready.some((i) => i.id === id),
        'Only ready items can be handed over',
        { itemId: id },
      );
    }
  }
  if (ready.length === 0) throw new DomainError('NOTHING_TO_FULFIL', 'No items are ready to hand over');
  return ready.map((i) => i.id);
}

export function assertOrderOpen(status: OrderStatus): void {
  if (TERMINAL_ORDER_STATUSES.has(status)) {
    throw new DomainError('ORDER_CLOSED', 'This order is already closed', { status });
  }
}

// ---------------------------------------------------------------------------
// Cancellation and voids (distinct operations, never interchangeable)
// ---------------------------------------------------------------------------
const NOT_STARTED: ReadonlySet<OrderItemStatus> = new Set(['pending', 'sent', 'accepted']);

/**
 * Cancelling a whole order is only allowed before any preparation started and
 * while no money is held against it. Otherwise staff must void items (waste is
 * recorded) and void or refund payments explicitly.
 */
export function planCancellation(items: readonly OrderItem[], netPaid: Minor): string[] {
  const active = items.filter(ACTIVE_ITEM);
  const started = active.filter((i) => !NOT_STARTED.has(i.status));
  if (started.length > 0) {
    throw new DomainError(
      'PRODUCTION_STARTED',
      'Preparation has started. Void the items instead of cancelling',
      {
        itemIds: started.map((i) => i.id),
      },
    );
  }
  if (netPaid > 0) {
    throw new DomainError('PAYMENTS_RECORDED', 'Void or refund the payments before cancelling this order');
  }
  return active.map((i) => i.id);
}

/**
 * Voiding removes specific items after they were sent (and possibly made or
 * served). Unsent items are simply cancelled; they never reached a station.
 */
export function planVoid(
  items: readonly OrderItem[],
  itemIds: readonly string[],
): { voided: string[]; cancelled: string[] } {
  if (itemIds.length === 0) throw new DomainError('NOTHING_TO_VOID', 'Choose the items to void');
  const voided: string[] = [];
  const cancelled: string[] = [];
  for (const id of new Set(itemIds)) {
    const item = items.find((i) => i.id === id);
    invariant(item, 'Item is not on this order', { itemId: id });
    if (!ACTIVE_ITEM(item))
      throw new DomainError('NOTHING_TO_VOID', `${item.name} was already removed`, { itemId: id });
    (item.status === 'pending' ? cancelled : voided).push(id);
  }
  return { voided, cancelled };
}
