import type { FulfilOrderCommand, OrderView, TicketActionCommand } from '@rp/contracts';
import {
  assertFulfilmentAllowed,
  assertOrderOpen,
  assertRecallAllowed,
  DomainError,
  itemStatusAfter,
  nextTicketStatus,
  planFulfilment,
  type TicketAction,
  type TicketStatus,
  ticketStatusAfterFulfilment,
} from '@rp/domain';
import type { OrderAggregate, Repositories, TicketPatch, TicketRecord } from '../ports';
import { authorize, type RequestContext } from '../principal';
import { CommitLog, type Dependencies, settleOrderState } from './shared';

/** Applies one ticket action (state machine + item moves + event). The order row must already be locked. */
async function applyTicketAction(
  tx: Repositories,
  ctx: RequestContext,
  agg: OrderAggregate,
  ticket: TicketRecord,
  action: TicketAction,
  now: Date,
  log: CommitLog,
): Promise<void> {
  const items = agg.items.filter((i) => ticket.itemIds.includes(i.id));
  if (action === 'recall') assertRecallAllowed(items.map((i) => i.status));
  const to = nextTicketStatus(ticket.status, action);

  const updates = items
    .map((i) => ({ item: i, next: itemStatusAfter(action, i.status) }))
    .filter((u) => u.next !== u.item.status);
  await tx.orders.updateItems(
    updates.map((u) => ({ itemId: u.item.id, status: u.next })),
    now,
  );
  for (const u of updates) u.item.status = u.next;

  const patch: TicketPatch = { status: to };
  if (action === 'accept') patch.acceptedAt = now;
  if (action === 'start') patch.startedAt = now;
  if (to === 'ready') patch.readyAt = now;
  if (to === 'completed') patch.completedAt = now;
  if (action === 'recall') Object.assign(patch, { readyAt: null, completedAt: null });
  await tx.production.update(ticket.id, patch, ticket.version, now);
  await tx.production.appendEvent({
    ticketId: ticket.id,
    action,
    fromStatus: ticket.status,
    toStatus: to,
    staffId: ctx.principal.staffId,
    deviceId: ctx.deviceId,
    correlationId: ctx.correlationId,
  });
  log.add('ticket.transitioned', {
    ticketId: ticket.id,
    orderId: agg.header.id,
    stationId: ticket.stationId,
    action,
    from: ticket.status,
    to,
  });
}

function assertNotCancelled(agg: OrderAggregate): void {
  if (agg.header.status === 'cancelled' || agg.header.status === 'voided') {
    throw new DomainError('ORDER_CLOSED', 'This order was cancelled', { orderId: agg.header.id });
  }
}

/** KDS actions: accept, start, pause, resume, ready, recall, complete (bump). */
export class TransitionTicket {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, ticketId: string, cmd: TicketActionCommand): Promise<OrderView> {
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const view = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      // Lock order first, then ticket: the same order every writer uses.
      const peek = await tx.production.find(ticketId);
      if (!peek) throw new DomainError('NOT_FOUND', 'Ticket not found', { ticketId });
      authorize(ctx.principal, 'kitchen.operate', peek.branchId);
      const { deviceKind, deviceStationId } = ctx.principal;
      if (deviceKind === 'kds' && deviceStationId && deviceStationId !== peek.stationId) {
        throw new DomainError('FORBIDDEN', 'This screen belongs to another station', { ticketId });
      }

      const agg = await tx.orders.findForUpdate(peek.orderId);
      if (!agg) throw new DomainError('NOT_FOUND', 'Order not found', { orderId: peek.orderId });
      const ticket = (await tx.production.findForUpdate(ticketId))!;
      if (cmd.expectedVersion && cmd.expectedVersion !== ticket.version) {
        throw new DomainError('VERSION_CONFLICT', 'This ticket was just updated on another screen', {
          ticketId,
          expected: cmd.expectedVersion,
          actual: ticket.version,
        });
      }
      assertNotCancelled(agg);
      await applyTicketAction(tx, ctx, agg, ticket, cmd.action, now, log);
      await settleOrderState(tx, agg, ctx, now, log);
      return (await tx.read.order(agg.header.id))!;
    });
    log.flush(this.deps.logger);
    return view;
  }
}

/**
 * Marks every open ticket of an order ready (expeditor / small counter with no
 * KDS). Same state machine as the KDS; needs kitchen permission.
 */
export class MarkOrderReady {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, orderId: string): Promise<OrderView> {
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const view = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const agg = await tx.orders.findForUpdate(orderId);
      if (!agg) throw new DomainError('NOT_FOUND', 'Order not found', { orderId });
      authorize(ctx.principal, 'kitchen.operate', agg.header.branchId);
      assertNotCancelled(agg);
      const open = (await tx.production.ticketsForOrder(orderId)).filter((t) =>
        ['new', 'accepted', 'in_preparation', 'on_hold'].includes(t.status),
      );
      for (const ticket of open) {
        const locked = (await tx.production.findForUpdate(ticket.id))!;
        await applyTicketAction(tx, ctx, agg, locked, 'ready', now, log);
      }
      await settleOrderState(tx, agg, ctx, now, log);
      return (await tx.read.order(orderId))!;
    });
    log.flush(this.deps.logger);
    return view;
  }
}

/** Waiter serves a table / counter hands over a takeaway. Moves ready items to served. */
export class FulfilOrder {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, orderId: string, cmd: FulfilOrderCommand): Promise<OrderView> {
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const view = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const agg = await tx.orders.findForUpdate(orderId);
      if (!agg) throw new DomainError('NOT_FOUND', 'Order not found', { orderId });
      authorize(ctx.principal, 'order.fulfil', agg.header.branchId);
      assertOrderOpen(agg.header.status);
      const area = await tx.config.area(agg.header.areaId);
      if (area) assertFulfilmentAllowed(area.paymentPolicy, agg.header.paymentStatus);

      const itemIds = planFulfilment(agg.items, cmd.itemIds ?? undefined);
      await tx.orders.updateItems(
        itemIds.map((itemId) => ({ itemId, status: 'served' as const })),
        now,
      );
      for (const item of agg.items) if (itemIds.includes(item.id)) item.status = 'served';

      for (const ticket of await tx.production.ticketsForOrder(orderId)) {
        if (!ticket.itemIds.some((id) => itemIds.includes(id))) continue;
        const statuses = agg.items.filter((i) => ticket.itemIds.includes(i.id)).map((i) => i.status);
        const next: TicketStatus = ticketStatusAfterFulfilment(ticket.status, statuses);
        if (next === ticket.status) continue;
        await tx.production.update(ticket.id, { status: next, completedAt: now }, ticket.version, now);
        await tx.production.appendEvent({
          ticketId: ticket.id,
          action: 'fulfilled',
          fromStatus: ticket.status,
          toStatus: next,
          staffId: ctx.principal.staffId,
          deviceId: ctx.deviceId,
          correlationId: ctx.correlationId,
        });
      }
      log.add('order.fulfilled', { orderId, orderNumber: agg.header.orderNumber, itemIds });
      await settleOrderState(tx, agg, ctx, now, log);
      return (await tx.read.order(orderId))!;
    });
    log.flush(this.deps.logger);
    return view;
  }
}
