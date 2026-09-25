import {
  ACTIVE_ITEM,
  computeTotals,
  deriveOrderStatus,
  derivePaymentStatus,
  type OrderStatus,
  summarizePayments,
} from '@rp/domain';
import type {
  AuthDirectory,
  Clock,
  Fingerprinter,
  IdentityRegistry,
  IdGenerator,
  LogFields,
  Logger,
  OrderAggregate,
  OrderHeader,
  OrderHeaderPatch,
  Repositories,
  SecretGenerator,
  UnitOfWork,
} from '../ports';
import type { RequestContext } from '../principal';

export interface Dependencies {
  uow: UnitOfWork;
  clock: Clock;
  ids: IdGenerator;
  fingerprint: Fingerprinter;
  logger: Logger;
  /** Needed only by staff and device administration use cases. */
  auth?: AuthDirectory;
  identity?: IdentityRegistry;
  secrets?: SecretGenerator;
  /** Email domain for device logins (never receives mail). */
  deviceAccountDomain?: string;
}

/**
 * Log lines are collected during the transaction and written only after it
 * commits, so logs never describe work that was rolled back.
 */
export class CommitLog {
  private readonly entries: { event: string; fields: LogFields }[] = [];

  constructor(private readonly ctx: RequestContext) {}

  add(event: string, fields: LogFields): void {
    this.entries.push({ event, fields });
  }

  flush(logger: Logger): void {
    const base = {
      correlationId: this.ctx.correlationId,
      restaurantId: this.ctx.principal.restaurantId,
      staffId: this.ctx.principal.staffId,
      deviceId: this.ctx.deviceId,
    };
    for (const e of this.entries) logger.info(e.event, { ...base, ...e.fields });
  }
}

const FULFILLED: ReadonlySet<OrderStatus> = new Set(['served', 'picked_up', 'completed']);

/**
 * Recomputes totals, payment status and fulfilment status from the order's
 * items and payments, and persists them (optimistic version check). This is
 * the only place an order's status is written.
 */
export async function settleOrderState(
  tx: Repositories,
  agg: OrderAggregate,
  ctx: RequestContext,
  now: Date,
  log: CommitLog,
): Promise<void> {
  const h = agg.header;
  const totals = computeTotals(agg.items);
  const paid = summarizePayments(agg.payments);
  const paymentStatus = derivePaymentStatus(totals.grandTotal, paid, agg.items.some(ACTIVE_ITEM));
  const status = deriveOrderStatus(h.status, h.channel, agg.items, paymentStatus);

  const patch: OrderHeaderPatch = {};
  const set = <K extends keyof OrderHeaderPatch & keyof OrderHeader>(key: K, value: OrderHeaderPatch[K]) => {
    if (h[key] !== value) patch[key] = value;
  };
  set('subtotal', totals.subtotal);
  set('taxTotal', totals.taxTotal);
  set('grandTotal', totals.grandTotal);
  set('paidTotal', paid.paidTotal);
  set('refundedTotal', paid.refundedTotal);
  set('paymentStatus', paymentStatus);
  set('status', status);
  if (status !== 'draft' && !h.firstSubmittedAt) patch.firstSubmittedAt = now;
  if (status === 'ready' && !h.readyAt) patch.readyAt = now;
  if (FULFILLED.has(status) && !h.fulfilledAt) patch.fulfilledAt = now;
  if (status === 'completed' && !h.completedAt) patch.completedAt = now;

  if (Object.keys(patch).length === 0) return;

  const version = await tx.orders.updateHeader(h.id, patch, h.version);
  if (patch.status) {
    await tx.orders.appendEvent({
      orderId: h.id,
      event: 'status_changed',
      fromStatus: h.status,
      toStatus: status,
      staffId: ctx.principal.staffId,
      deviceId: ctx.deviceId,
      correlationId: ctx.correlationId,
    });
    log.add('order.status_changed', {
      orderId: h.id,
      orderNumber: h.orderNumber,
      from: h.status,
      to: status,
    });
    if (h.tableId && status === 'completed') await tx.config.setTableStatus(h.tableId, 'cleaning', now);
    if (h.tableId && (status === 'cancelled' || status === 'voided')) {
      await tx.config.setTableStatus(h.tableId, 'available', now);
    }
  }
  Object.assign(h, patch, { version });
}
