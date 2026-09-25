import type {
  CancelOrderCommand,
  OrderView,
  PrintReceiptCommand,
  ReceiptView,
  VoidItemsCommand,
} from '@rp/contracts';
import {
  DomainError,
  planCancellation,
  planVoid,
  receiptDocument,
  summarizePayments,
  voidSlipDocument,
} from '@rp/domain';
import type { NewPrintJob, OrderAggregate, Repositories } from '../ports';
import { authorize, type RequestContext } from '../principal';
import { reverseStockForOrder } from './inventory';
import { CommitLog, type Dependencies, settleOrderState } from './shared';

/**
 * Four corrections that are deliberately NOT interchangeable:
 *   CancelOrder  - nothing started, no money held: the order never happened
 *   VoidItems    - specific items removed after being sent (waste is recorded)
 *   VoidPayment  - a payment record was wrong (payments.ts)
 *   RefundPayment- money given back (payments.ts)
 */
export class CancelOrder {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, orderId: string, cmd: CancelOrderCommand): Promise<OrderView> {
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const view = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const agg = await lock(tx, orderId);
      authorize(ctx.principal, 'order.cancel', agg.header.branchId);
      if (agg.header.status === 'cancelled') return (await tx.read.order(orderId))!; // idempotent
      if (agg.header.status === 'completed' || agg.header.status === 'voided') {
        throw new DomainError('ORDER_CLOSED', 'This order is already closed');
      }
      const paid = summarizePayments(agg.payments);
      const itemIds = planCancellation(agg.items, paid.paidTotal - paid.refundedTotal);

      await tx.orders.updateItems(
        itemIds.map((itemId) => ({ itemId, status: 'cancelled' as const })),
        now,
      );
      for (const i of agg.items) if (itemIds.includes(i.id)) i.status = 'cancelled';
      const slipJobs = await cancelTicketsAndPrintSlips(
        this.deps,
        tx,
        ctx,
        agg,
        itemIds,
        cmd.reason,
        true,
        orderId,
        now,
      );

      await tx.orders.updateHeader(
        orderId,
        { cancelledAt: now, cancelReason: cmd.reason, cancelledByStaffId: ctx.principal.staffId },
        agg.header.version,
      );
      agg.header.version += 1;
      // Stock the order's sales took goes back (compensating movements; at most once per item).
      const stockReturned = await reverseStockForOrder(tx, this.deps, {
        orderId,
        relatedOrderIds: await tx.orders.mergedFrom(orderId),
        orderNumber: agg.header.orderNumber,
        staffId: ctx.principal.staffId,
        reason: cmd.reason,
      });
      await tx.audit.append({
        branchId: agg.header.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'order.cancel',
        entityType: 'order',
        entityId: orderId,
        before: { status: agg.header.status },
        after: { status: 'cancelled', items: itemIds.length, stockItemsReturned: stockReturned.length },
        reason: cmd.reason,
        correlationId: ctx.correlationId,
      });
      log.add('order.cancelled', { orderId, orderNumber: agg.header.orderNumber, printJobIds: slipJobs });
      await settleOrderState(tx, agg, ctx, now, log);
      return (await tx.read.order(orderId))!;
    });
    log.flush(this.deps.logger);
    return view;
  }
}

export class VoidItems {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, orderId: string, cmd: VoidItemsCommand): Promise<OrderView> {
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const view = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const agg = await lock(tx, orderId);
      authorize(ctx.principal, 'order.void', agg.header.branchId);
      // Replay of the same void request: everything already removed, nothing to do.
      const requested = agg.items.filter((i) => cmd.itemIds.includes(i.id));
      if (
        requested.length === cmd.itemIds.length &&
        requested.every((i) => i.status === 'voided' || i.status === 'cancelled')
      ) {
        return (await tx.read.order(orderId))!;
      }
      if (
        agg.header.status === 'completed' ||
        agg.header.status === 'cancelled' ||
        agg.header.status === 'voided'
      ) {
        throw new DomainError('ORDER_CLOSED', 'This order is closed. Use a refund instead');
      }
      const plan = planVoid(agg.items, cmd.itemIds);
      const updates = [
        ...plan.voided.map((itemId) => ({
          itemId,
          status: 'voided' as const,
          voidReason: cmd.reason,
          voidedByStaffId: ctx.principal.staffId,
        })),
        ...plan.cancelled.map((itemId) => ({ itemId, status: 'cancelled' as const })),
      ];
      const before = agg.items
        .filter((i) => cmd.itemIds.includes(i.id))
        .map((i) => ({ id: i.id, name: i.name, status: i.status }));
      await tx.orders.updateItems(updates, now);
      for (const u of updates) agg.items.find((i) => i.id === u.itemId)!.status = u.status;

      const slipJobs = await cancelTicketsAndPrintSlips(
        this.deps,
        tx,
        ctx,
        agg,
        plan.voided,
        cmd.reason,
        false,
        cmd.requestId,
        now,
      );
      await tx.audit.append({
        branchId: agg.header.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'order.void_items',
        entityType: 'order',
        entityId: orderId,
        before,
        after: { voided: plan.voided, cancelled: plan.cancelled },
        reason: cmd.reason,
        correlationId: ctx.correlationId,
      });
      log.add('order.items_voided', {
        orderId,
        voided: plan.voided,
        cancelled: plan.cancelled,
        printJobIds: slipJobs,
      });
      await settleOrderState(tx, agg, ctx, now, log);
      return (await tx.read.order(orderId))!;
    });
    log.flush(this.deps.logger);
    return view;
  }
}

/**
 * Tickets whose items are all gone are cancelled; every affected station gets
 * a void slip on the printers that printed the original ticket.
 */
async function cancelTicketsAndPrintSlips(
  deps: Dependencies,
  tx: Repositories,
  ctx: RequestContext,
  agg: OrderAggregate,
  removedItemIds: readonly string[],
  reason: string,
  wholeOrder: boolean,
  requestKey: string,
  now: Date,
): Promise<string[]> {
  if (removedItemIds.length === 0) return [];
  const [branch, snapshot] = await Promise.all([
    tx.config.branch(agg.header.branchId),
    tx.config.routingSnapshot(agg.header.branchId),
  ]);
  const tableLabel = agg.header.tableId ? ((await tx.config.table(agg.header.tableId))?.label ?? null) : null;
  const jobs: NewPrintJob[] = [];
  for (const ticket of await tx.production.ticketsForOrder(agg.header.id)) {
    const removed = ticket.itemIds.filter((id) => removedItemIds.includes(id));
    if (removed.length === 0) continue;
    const allGone = agg.items
      .filter((i) => ticket.itemIds.includes(i.id))
      .every((i) => i.status === 'voided' || i.status === 'cancelled');
    if (allGone && ticket.status !== 'cancelled' && ticket.status !== 'completed') {
      await tx.production.update(ticket.id, { status: 'cancelled' }, ticket.version, now);
      await tx.production.appendEvent({
        ticketId: ticket.id,
        action: wholeOrder ? 'order_cancelled' : 'voided',
        fromStatus: ticket.status,
        toStatus: 'cancelled',
        staffId: ctx.principal.staffId,
        deviceId: ctx.deviceId,
        correlationId: ctx.correlationId,
      });
    }
    const stationName = snapshot.stations.find((s) => s.id === ticket.stationId)?.name ?? 'Station';
    const document = voidSlipDocument({
      stationName,
      orderNumber: agg.header.orderNumber,
      tableLabel,
      reason,
      createdAt: now,
      timeZone: branch?.timezone ?? 'UTC',
      items: agg.items
        .filter((i) => removed.includes(i.id))
        .map((i) => ({ quantity: i.quantity, name: i.kitchenName ?? i.name })),
      wholeOrder,
    });
    for (const printerId of await tx.production.printersForTicket(ticket.id)) {
      jobs.push({
        id: deps.ids.uuid(),
        branchId: agg.header.branchId,
        printerId,
        originalPrinterId: printerId,
        kind: 'void_slip',
        orderId: agg.header.id,
        productionTicketId: ticket.id,
        copyNo: 1,
        dedupeKey: `void_slip:${requestKey}:${ticket.id}:${printerId}`,
        document,
        createdAt: now,
      });
    }
  }
  await tx.printJobs.insert(jobs);
  return jobs.map((j) => j.id);
}

async function lock(tx: Repositories, orderId: string): Promise<OrderAggregate> {
  const agg = await tx.orders.findForUpdate(orderId);
  if (!agg) throw new DomainError('NOT_FOUND', 'Order not found', { orderId });
  return agg;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/** Receipt document for on-screen display or browser printing. Reading a receipt never changes the sale. */
export class GetReceipt {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, orderId: string): Promise<ReceiptView> {
    const now = this.deps.clock.now();
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const order = await tx.read.order(orderId);
      if (!order) throw new DomainError('NOT_FOUND', 'Order not found', { orderId });
      authorize(ctx.principal, 'order.view', order.branchId);
      const data = (await tx.read.receiptData(orderId))!;
      return {
        orderId,
        orderNumber: order.orderNumber,
        document: receiptDocument({ ...data, issuedAt: now }),
      };
    });
  }
}

/**
 * Queues a receipt on a printer. The first receipt for an order is the
 * original; every later one is printed as REPRINT and audited. Printing never
 * creates or changes a sale. Retrying with the same requestId prints once.
 */
export class PrintReceipt {
  constructor(private readonly deps: Dependencies) {}

  async execute(
    ctx: RequestContext,
    orderId: string,
    cmd: PrintReceiptCommand,
  ): Promise<{ printJobId: string; isReprint: boolean }> {
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const result = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const agg = await lock(tx, orderId);
      authorize(ctx.principal, 'receipt.print', agg.header.branchId);
      const dedupeKey = `receipt:${cmd.requestId}`;
      const printerId =
        cmd.printerId ?? (ctx.deviceId ? await tx.printJobs.receiptPrinterForDevice(ctx.deviceId) : null);
      if (!printerId)
        throw new DomainError('VALIDATION_FAILED', 'No receipt printer is set up for this till');
      if (!(await tx.printJobs.printerInBranch(printerId, agg.header.branchId))) {
        throw new DomainError('NOT_FOUND', 'Receipt printer not found');
      }
      const replay = await tx.printJobs.findByDedupeKey(dedupeKey);
      if (replay) return { printJobId: replay.id, isReprint: replay.isReprint }; // same request again: nothing new
      const previous = await tx.printJobs.countForOrder(orderId, 'receipt');
      const data = (await tx.read.receiptData(orderId))!;
      const id = this.deps.ids.uuid();
      await tx.printJobs.insert([
        {
          id,
          branchId: agg.header.branchId,
          printerId,
          originalPrinterId: printerId,
          kind: 'receipt',
          orderId,
          productionTicketId: null,
          copyNo: 1,
          dedupeKey,
          document: receiptDocument({ ...data, issuedAt: now }),
          createdAt: now,
          isReprint: previous > 0,
        },
      ]);
      if (previous > 0) {
        await tx.audit.append({
          branchId: agg.header.branchId,
          actorStaffId: ctx.principal.staffId,
          actorDeviceId: ctx.deviceId,
          action: 'receipt.reprint',
          entityType: 'order',
          entityId: orderId,
          after: { printJobId: id, printerId, previousReceipts: previous },
          correlationId: ctx.correlationId,
        });
      }
      log.add('receipt.queued', { orderId, printJobId: id, printerId, reprint: previous > 0 });
      return { printJobId: id, isReprint: previous > 0 };
    });
    log.flush(this.deps.logger);
    return result;
  }
}
