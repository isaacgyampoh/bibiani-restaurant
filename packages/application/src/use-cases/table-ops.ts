import type { OrderView } from '@rp/contracts';
import { DomainError } from '@rp/domain';
import type { OrderAggregate, Repositories } from '../ports';
import { authorize, type RequestContext } from '../principal';
import { CommitLog, type Dependencies, settleOrderState } from './shared';

/**
 * Floor operations. Each keeps the full history: order events and audit entries record what moved
 * where; nothing is deleted. Kitchen screens show the new table immediately (they read it live).
 */
const CLOSED = new Set(['completed', 'cancelled', 'voided']);

async function lockOpen(tx: Repositories, orderId: string): Promise<OrderAggregate> {
  const agg = await tx.orders.findForUpdate(orderId);
  if (!agg) throw new DomainError('NOT_FOUND', 'Order not found', { orderId });
  if (CLOSED.has(agg.header.status) || agg.header.mergedIntoOrderId)
    throw new DomainError('ORDER_CLOSED', `Order #${agg.header.orderNumber} is already closed`);
  return agg;
}

/** Moves an order to another table, or converts it between dine-in and takeaway. */
export class TransferOrder {
  constructor(private readonly deps: Dependencies) {}

  async execute(
    ctx: RequestContext,
    orderId: string,
    cmd: { areaId: string; tableId?: string | null; customerName?: string | null },
  ): Promise<OrderView> {
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const agg = await lockOpen(tx, orderId);
      const h = agg.header;
      authorize(ctx.principal, 'order.create', h.branchId);
      const area = await tx.config.area(cmd.areaId);
      if (!area || area.branchId !== h.branchId || !area.isActive)
        throw new DomainError('NOT_FOUND', 'Service area not found');
      let tableLabel: string | null = null;
      if (area.channel === 'dine_in') {
        if (!cmd.tableId) throw new DomainError('TABLE_REQUIRED', 'Choose the table to move this order to');
        const table = await tx.config.table(cmd.tableId);
        if (!table || table.branchId !== h.branchId || table.areaId !== area.id)
          throw new DomainError('NOT_FOUND', 'Table not found');
        if (cmd.tableId === h.tableId)
          throw new DomainError('VALIDATION_FAILED', 'The order is already at this table');
        const busy = await tx.orders.activeOrderIdForTable(cmd.tableId);
        if (busy && busy !== orderId)
          throw new DomainError(
            'TABLE_UNAVAILABLE',
            `Table ${table.label} already has an open order. Merge instead.`,
          );
        tableLabel = table.label;
      } else if (area.requiresCustomerName && !(cmd.customerName ?? h.customerName)?.trim()) {
        throw new DomainError('CUSTOMER_NAME_REQUIRED', 'Enter the customer name for takeaway');
      }
      const from = { areaId: h.areaId, tableId: h.tableId, channel: h.channel };
      await tx.orders.updateHeader(
        orderId,
        {
          areaId: area.id,
          channel: area.channel,
          tableId: area.channel === 'dine_in' ? cmd.tableId! : null,
          customerName: cmd.customerName?.trim() || h.customerName,
        },
        h.version,
      );
      const payload = { from, to: { areaId: area.id, tableId: cmd.tableId ?? null, channel: area.channel } };
      await tx.orders.appendEvent({
        orderId,
        event: 'order.transferred',
        staffId: ctx.principal.staffId,
        deviceId: ctx.deviceId,
        correlationId: ctx.correlationId,
        payload,
      });
      await tx.audit.append({
        branchId: h.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'order.transfer',
        entityType: 'order',
        entityId: orderId,
        before: from,
        after: { ...payload.to, tableLabel },
        correlationId: ctx.correlationId,
      });
      return (await tx.read.order(orderId))!;
    });
  }
}

/**
 * Merges one open order into another (e.g. two tables joining): items, kitchen rounds, tickets and
 * payments move to the target, which gets one bill. The merged order is closed with a pointer to the
 * target and keeps its own event history; its stock sales are reversed with the target if cancelled.
 */
export class MergeOrders {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, targetId: string, sourceId: string): Promise<OrderView> {
    if (targetId === sourceId)
      throw new DomainError('VALIDATION_FAILED', 'Choose a different order to merge');
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const view = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      // Lock in a fixed order so two opposite merges cannot deadlock.
      const [first, second] = [targetId, sourceId].sort();
      const a = await lockOpen(tx, first!);
      const b = await lockOpen(tx, second!);
      const target = a.header.id === targetId ? a : b;
      const source = a.header.id === sourceId ? a : b;
      authorize(ctx.principal, 'order.create', target.header.branchId);
      if (source.header.branchId !== target.header.branchId)
        throw new DomainError('ORDER_NOT_MOVABLE', 'Orders from different branches cannot be merged');

      const moved = await tx.orders.moveContents(sourceId, targetId, target.header.orderNumber);
      await tx.orders.updateHeader(
        sourceId,
        {
          status: 'cancelled',
          subtotal: 0,
          taxTotal: 0,
          grandTotal: 0,
          paidTotal: 0,
          refundedTotal: 0,
          tableId: null,
          cancelledAt: now,
          cancelReason: `Merged into order #${target.header.orderNumber}`,
          cancelledByStaffId: ctx.principal.staffId,
          mergedIntoOrderId: targetId,
        },
        source.header.version,
      );
      for (const [orderId, event] of [
        [sourceId, 'order.merged_away'],
        [targetId, 'order.merged_in'],
      ] as const) {
        await tx.orders.appendEvent({
          orderId,
          event,
          staffId: ctx.principal.staffId,
          deviceId: ctx.deviceId,
          correlationId: ctx.correlationId,
          payload: {
            sourceOrderNumber: source.header.orderNumber,
            targetOrderNumber: target.header.orderNumber,
            ...moved,
          },
        });
      }
      await tx.audit.append({
        branchId: target.header.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'order.merge',
        entityType: 'order',
        entityId: targetId,
        before: { source: source.header.orderNumber, target: target.header.orderNumber },
        after: moved,
        correlationId: ctx.correlationId,
      });
      // Recompute the target from what it now holds.
      const merged = (await tx.orders.findForUpdate(targetId))!;
      await settleOrderState(tx, merged, ctx, now, log);
      return (await tx.read.order(targetId))!;
    });
    log.flush(this.deps.logger);
    return view;
  }
}

/** Marks an order as a rush: kitchen screens put it first and flag it. */
export class SetOrderPriority {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, orderId: string, rush: boolean): Promise<OrderView> {
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const agg = await lockOpen(tx, orderId);
      authorize(ctx.principal, 'order.send', agg.header.branchId);
      if (agg.header.isRush === rush) return (await tx.read.order(orderId))!;
      await tx.orders.updateHeader(orderId, { isRush: rush }, agg.header.version);
      await tx.orders.appendEvent({
        orderId,
        event: rush ? 'order.rush' : 'order.rush_cleared',
        staffId: ctx.principal.staffId,
        deviceId: ctx.deviceId,
        correlationId: ctx.correlationId,
      });
      await tx.audit.append({
        branchId: agg.header.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'order.priority',
        entityType: 'order',
        entityId: orderId,
        after: { rush },
        correlationId: ctx.correlationId,
      });
      return (await tx.read.order(orderId))!;
    });
  }
}
