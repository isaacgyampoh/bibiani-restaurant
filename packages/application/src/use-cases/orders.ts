import type { OrderView, SendToKitchenCommand, SubmitOrderCommand } from '@rp/contracts';
import {
  ACTIVE_ITEM,
  assertOrderOpen,
  businessDay,
  computeTotals,
  DomainError,
  derivePaymentStatus,
  kitchenTicketDocument,
  type NewItemInput,
  type OrderItem,
  planSubmission,
  priceNewItem,
  sameItemRequest,
  summarizePayments,
} from '@rp/domain';
import type { NewPrintJob, NewTicket, OrderAggregate, Repositories, RoutingSnapshot } from '../ports';
import { authorize, type RequestContext } from '../principal';
import { CommitLog, type Dependencies, settleOrderState } from './shared';

/**
 * Create-or-continue an order, add items, and optionally send every pending
 * item to production, all in ONE transaction. Safe to retry with the same ids:
 *   orderId       -> never creates a second order
 *   item ids      -> never adds a line twice
 *   submissionId  -> never creates a second set of tickets or print jobs
 */
export class SubmitOrder {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, cmd: SubmitOrderCommand): Promise<OrderView> {
    const { principal } = ctx;
    authorize(principal, 'order.create', cmd.branchId);
    if (cmd.send) authorize(principal, 'order.send', cmd.branchId);
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const openHash = this.deps.fingerprint.of({
      branchId: cmd.branchId,
      areaId: cmd.areaId,
      tableId: cmd.tableId ?? null,
      customerName: cmd.customerName ?? null,
      customerPhone: cmd.customerPhone ?? null,
      notes: cmd.notes ?? null,
    });
    const submissionHash = this.deps.fingerprint.of({ op: 'submit_order', cmd });

    // Short transaction #1: reserve the order number (holds the branch counter lock only briefly).
    const reservation = await this.deps.uow.run(principal.restaurantId, (tx) =>
      reserveOrderNumber(tx, cmd.orderId, cmd.branchId, now),
    );

    // Transaction #2: everything else, atomically.
    const view = await this.deps.uow.run(principal.restaurantId, async (tx) => {
      await tx.orders.lockOrderId(cmd.orderId);
      let agg = await tx.orders.findForUpdate(cmd.orderId);
      if (agg) {
        if (agg.header.requestHash !== openHash) {
          throw new DomainError(
            'IDEMPOTENCY_MISMATCH',
            'This order id was already used for a different order',
            {
              orderId: cmd.orderId,
            },
          );
        }
      } else {
        if (!reservation) throw new Error(`No order number reserved for ${cmd.orderId}`);
        agg = await this.openOrder(tx, ctx, cmd, openHash, now, log, reservation);
      }

      if (cmd.send) {
        const replay = await replayedSubmission(tx, cmd.send.submissionId, cmd.orderId, submissionHash);
        if (replay) {
          log.add('order.submit_replayed', { orderId: cmd.orderId, submissionId: cmd.send.submissionId });
          return replay;
        }
      }

      assertOrderOpen(agg.header.status);
      await addItems(tx, agg, cmd.items, cmd.branchId, log);
      if (cmd.send) {
        await sendPendingItems(this.deps, tx, ctx, agg, cmd.send.submissionId, submissionHash, now, log);
      }
      await settleOrderState(tx, agg, ctx, now, log);
      return mustRead(tx, cmd.orderId);
    });

    log.flush(this.deps.logger);
    return view;
  }

  private async openOrder(
    tx: Repositories,
    ctx: RequestContext,
    cmd: SubmitOrderCommand,
    requestHash: string,
    now: Date,
    log: CommitLog,
    reservation: { businessDay: string; orderNumber: number },
  ): Promise<OrderAggregate> {
    const branch = await tx.config.branch(cmd.branchId);
    if (!branch?.isActive) throw new DomainError('NOT_FOUND', 'Branch not found', { branchId: cmd.branchId });
    const area = await tx.config.area(cmd.areaId);
    if (!area?.isActive || area.branchId !== branch.id) {
      throw new DomainError('NOT_FOUND', 'Ordering area not found', { areaId: cmd.areaId });
    }

    let tableLabel: string | null = null;
    if (area.requiresTable && !cmd.tableId)
      throw new DomainError('TABLE_REQUIRED', 'Choose a table for this order');
    if (cmd.tableId) {
      const table = await tx.config.table(cmd.tableId);
      if (!table?.isActive || table.branchId !== branch.id || table.areaId !== area.id) {
        throw new DomainError('NOT_FOUND', 'Table not found', { tableId: cmd.tableId });
      }
      if (table.status === 'out_of_service') {
        throw new DomainError('TABLE_UNAVAILABLE', `Table ${table.label} is out of service`);
      }
      const activeOrderId = await tx.orders.activeOrderIdForTable(table.id);
      if (activeOrderId) {
        throw new DomainError('TABLE_UNAVAILABLE', `Table ${table.label} already has an open order`, {
          tableId: table.id,
          activeOrderId,
        });
      }
      tableLabel = table.label;
    }
    if (area.requiresCustomerName && !cmd.customerName) {
      throw new DomainError('CUSTOMER_NAME_REQUIRED', 'Enter the customer name');
    }

    const day = reservation.businessDay;
    const orderNumber = reservation.orderNumber;
    await tx.orders.insertHeader({
      id: cmd.orderId,
      branchId: branch.id,
      areaId: area.id,
      channel: area.channel,
      businessDay: day,
      orderNumber,
      status: 'draft',
      paymentStatus: 'unpaid',
      tableId: cmd.tableId ?? null,
      customerName: cmd.customerName ?? null,
      customerPhone: cmd.customerPhone ?? null,
      notes: cmd.notes ?? null,
      subtotal: 0,
      taxTotal: 0,
      grandTotal: 0,
      paidTotal: 0,
      refundedTotal: 0,
      requestHash,
      createdAt: now,
      createdByStaffId: ctx.principal.staffId,
      createdByDeviceId: ctx.deviceId,
      clientCreatedAt: cmd.clientCreatedAt ? new Date(cmd.clientCreatedAt) : null,
    });
    if (cmd.tableId) await tx.config.setTableStatus(cmd.tableId, 'occupied', now);
    await tx.orders.appendEvent({
      orderId: cmd.orderId,
      event: 'created',
      toStatus: 'draft',
      staffId: ctx.principal.staffId,
      deviceId: ctx.deviceId,
      correlationId: ctx.correlationId,
      payload: { orderNumber, businessDay: day, table: tableLabel },
    });
    log.add('order.created', {
      orderId: cmd.orderId,
      orderNumber,
      branchId: branch.id,
      channel: area.channel,
    });

    // Freshly inserted in this transaction (and locked by it): build the aggregate without another round trip.
    return {
      header: {
        id: cmd.orderId,
        branchId: branch.id,
        areaId: area.id,
        channel: area.channel,
        businessDay: day,
        orderNumber,
        status: 'draft',
        paymentStatus: 'unpaid',
        tableId: cmd.tableId ?? null,
        customerName: cmd.customerName ?? null,
        customerPhone: cmd.customerPhone ?? null,
        notes: cmd.notes ?? null,
        subtotal: 0,
        taxTotal: 0,
        grandTotal: 0,
        paidTotal: 0,
        refundedTotal: 0,
        requestHash,
        version: 1,
        createdAt: now,
        firstSubmittedAt: null,
        readyAt: null,
        fulfilledAt: null,
        completedAt: null,
      },
      items: [],
      payments: [],
    };
  }
}

/** Sends every pending item of an existing order (used when payment must come first). */
export class SendOrderToKitchen {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, orderId: string, cmd: SendToKitchenCommand): Promise<OrderView> {
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const hash = this.deps.fingerprint.of({ op: 'send_to_kitchen', orderId });

    const view = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const agg = await tx.orders.findForUpdate(orderId);
      if (!agg) throw new DomainError('NOT_FOUND', 'Order not found', { orderId });
      authorize(ctx.principal, 'order.send', agg.header.branchId);
      const replay = await replayedSubmission(tx, cmd.submissionId, orderId, hash);
      if (replay) return replay;
      assertOrderOpen(agg.header.status);
      await sendPendingItems(this.deps, tx, ctx, agg, cmd.submissionId, hash, now, log);
      await settleOrderState(tx, agg, ctx, now, log);
      return mustRead(tx, orderId);
    });
    log.flush(this.deps.logger);
    return view;
  }
}

// ---------------------------------------------------------------------------

async function replayedSubmission(
  tx: Repositories,
  submissionId: string,
  orderId: string,
  requestHash: string,
): Promise<OrderView | null> {
  const existing = await tx.orders.findSubmission(submissionId);
  if (!existing) return null;
  if (existing.orderId !== orderId || existing.requestHash !== requestHash) {
    throw new DomainError('IDEMPOTENCY_MISMATCH', 'This send was already used for a different request', {
      submissionId,
    });
  }
  return mustRead(tx, orderId);
}

async function mustRead(tx: Repositories, orderId: string): Promise<OrderView> {
  const view = await tx.read.order(orderId);
  if (!view) throw new DomainError('NOT_FOUND', 'Order not found', { orderId });
  return view;
}

async function addItems(
  tx: Repositories,
  agg: OrderAggregate,
  inputs: readonly SubmitOrderCommand['items'][number][],
  branchId: string,
  log: CommitLog,
): Promise<void> {
  const fresh: NewItemInput[] = [];
  for (const input of inputs) {
    const normalized: NewItemInput = {
      id: input.id,
      productId: input.productId,
      quantity: input.quantity,
      modifierIds: input.modifierIds ?? [],
      notes: input.notes ?? null,
    };
    const existing = agg.items.find((i) => i.id === input.id);
    if (existing) {
      if (!sameItemRequest(existing, normalized)) {
        throw new DomainError('IDEMPOTENCY_MISMATCH', 'This item id was already used for a different line', {
          itemId: input.id,
        });
      }
      continue;
    }
    if (fresh.some((f) => f.id === input.id)) {
      throw new DomainError('VALIDATION_FAILED', 'The same item id appears twice', { itemId: input.id });
    }
    fresh.push(normalized);
  }
  if (fresh.length === 0) return;

  const products = await tx.catalog.productsForSale(branchId, [...new Set(fresh.map((f) => f.productId))]);
  const priced: OrderItem[] = fresh.map((input) => {
    const product = products.get(input.productId);
    if (!product) {
      throw new DomainError('VALIDATION_FAILED', 'A product on this order no longer exists', {
        productId: input.productId,
      });
    }
    return priceNewItem(input, product);
  });
  await tx.orders.insertItems(agg.header.id, priced);
  agg.items.push(...priced);
  log.add('order.items_added', { orderId: agg.header.id, itemIds: priced.map((i) => i.id) });
}

async function sendPendingItems(
  deps: Dependencies,
  tx: Repositories,
  ctx: RequestContext,
  agg: OrderAggregate,
  submissionId: string,
  requestHash: string,
  now: Date,
  log: CommitLog,
): Promise<void> {
  const h = agg.header;
  const [area, branch, snapshot] = await Promise.all([
    tx.config.area(h.areaId),
    tx.config.branch(h.branchId),
    tx.config.routingSnapshot(h.branchId),
  ]);
  if (!area || !branch) throw new Error(`Order ${h.id} references a missing branch or area`);

  if (area.requirePaymentBeforeProduction) {
    const paymentStatus = derivePaymentStatus(
      computeTotals(agg.items).grandTotal,
      summarizePayments(agg.payments),
      agg.items.some(ACTIVE_ITEM),
    );
    if (paymentStatus !== 'paid') {
      throw new DomainError('PAYMENT_REQUIRED_BEFORE_PRODUCTION', 'Take payment before sending this order');
    }
  }

  const stations = new Map(snapshot.stations.filter((s) => s.isActive).map((s) => [s.id, s]));
  const plan = planSubmission(
    agg.items,
    h.areaId,
    {
      rules: snapshot.rules,
      categoryParents: snapshot.categoryParents,
      reachableStationIds: reachableStations(snapshot),
    },
    stations,
  );

  const seq = await tx.orders.insertSubmission({
    id: submissionId,
    orderId: h.id,
    requestHash,
    staffId: ctx.principal.staffId,
    deviceId: ctx.deviceId,
    submittedAt: now,
  });
  await tx.orders.updateItems(
    plan.itemUpdates.map((u) => ({ ...u, submissionId })),
    now,
  );
  for (const u of plan.itemUpdates) {
    const item = agg.items.find((i) => i.id === u.itemId)!;
    Object.assign(item, { status: u.status, stationId: u.stationId, submissionId });
  }

  const tickets: NewTicket[] = plan.tickets.map((t) => ({
    id: deps.ids.uuid(),
    branchId: h.branchId,
    orderId: h.id,
    submissionId,
    stationId: t.stationId,
    orderNumber: h.orderNumber,
    status: t.initiallyReady ? 'ready' : 'new',
    itemIds: t.itemIds,
    readyAt: t.initiallyReady ? now : null,
    createdAt: now,
  }));
  await tx.production.insertTickets(tickets);

  const tableLabel = h.tableId ? ((await tx.config.table(h.tableId))?.label ?? null) : null;
  const jobs: NewPrintJob[] = [];
  for (const [index, ticket] of tickets.entries()) {
    const planned = plan.tickets[index]!;
    const station = stations.get(ticket.stationId)!;
    const document = kitchenTicketDocument({
      stationName: station.name,
      orderNumber: h.orderNumber,
      channel: h.channel,
      areaName: area.name,
      tableLabel,
      customerName: h.customerName,
      orderNotes: h.notes,
      createdAt: now,
      timeZone: branch.timezone,
      submissionSeq: seq,
      ticketId: ticket.id,
      items: ticket.itemIds.map((id) => {
        const item = agg.items.find((i) => i.id === id)!;
        return {
          quantity: item.quantity,
          name: item.kitchenName ?? item.name,
          modifiers: item.modifiers.map((m) => m.name),
          notes: item.notes,
        };
      }),
    });
    const ruleIds = [...new Set(planned.decisions.map((d) => d.ruleId))];
    for (const target of printTargets(snapshot, ticket.stationId, ruleIds)) {
      for (let copy = 1; copy <= target.copies; copy++) {
        jobs.push({
          id: deps.ids.uuid(),
          branchId: h.branchId,
          printerId: target.printerId,
          originalPrinterId: target.printerId,
          kind: 'kitchen_ticket',
          orderId: h.id,
          productionTicketId: ticket.id,
          copyNo: copy,
          dedupeKey: `kitchen_ticket:${ticket.id}:${target.printerId}:${copy}`,
          document,
          createdAt: now,
        });
      }
    }
  }
  await tx.production.appendEvents(
    tickets.map((ticket) => ({
      ticketId: ticket.id,
      action: 'created',
      fromStatus: null,
      toStatus: ticket.status,
      staffId: ctx.principal.staffId,
      deviceId: ctx.deviceId,
      correlationId: ctx.correlationId,
    })),
  );
  await tx.printJobs.insert(jobs);

  await tx.orders.appendEvent({
    orderId: h.id,
    event: 'submitted',
    staffId: ctx.principal.staffId,
    deviceId: ctx.deviceId,
    correlationId: ctx.correlationId,
    payload: { submissionId, seq, ticketIds: tickets.map((t) => t.id), printJobIds: jobs.map((j) => j.id) },
  });
  log.add('order.submitted', {
    orderId: h.id,
    orderNumber: h.orderNumber,
    submissionId,
    seq,
    tickets: tickets.map((t) => ({ ticketId: t.id, stationId: t.stationId, items: t.itemIds.length })),
    printJobIds: jobs.map((j) => j.id),
  });
  const stationsWithoutPrinter = tickets.filter((t) => !jobs.some((j) => j.productionTicketId === t.id));
  if (stationsWithoutPrinter.length > 0) {
    log.add('order.tickets_without_printer', {
      orderId: h.id,
      ticketIds: stationsWithoutPrinter.map((t) => t.id),
      note: 'Station has a KDS but no active printer',
    });
  }
}

/** A station can receive work if it has at least one active output device (or an active backup printer). */
function reachableStations(snapshot: RoutingSnapshot): Set<string> {
  const reachable = new Set<string>();
  for (const o of snapshot.outputs) {
    if (o.deviceActive || (o.deviceKind === 'printer' && o.backupPrinterId && o.backupActive)) {
      reachable.add(o.stationId);
    }
  }
  return reachable;
}

function printTargets(
  snapshot: RoutingSnapshot,
  stationId: string,
  ruleIds: readonly string[],
): { printerId: string; copies: number }[] {
  const targets = new Map<string, number>();
  const add = (printerId: string, copies: number) =>
    targets.set(printerId, Math.max(copies, targets.get(printerId) ?? 0));
  const printers = snapshot.outputs.filter((o) => o.stationId === stationId && o.deviceKind === 'printer');

  for (const o of printers.filter((p) => p.role === 'primary' || p.role === 'copy')) {
    if (o.deviceActive) add(o.deviceId, o.copies);
    else if (o.backupPrinterId && o.backupActive) add(o.backupPrinterId, o.copies);
  }
  if (targets.size === 0) {
    for (const o of printers.filter((p) => p.role === 'backup' && p.deviceActive)) add(o.deviceId, o.copies);
  }
  for (const ruleId of ruleIds) {
    for (const printerId of snapshot.ruleExtraPrinters.get(ruleId) ?? []) add(printerId, 1);
  }
  return [...targets].map(([printerId, copies]) => ({ printerId, copies }));
}

/**
 * Reserves a human order number for a client order id, idempotently. Returns
 * null when the order already exists (a retry or a later round).
 */
async function reserveOrderNumber(
  tx: Repositories,
  orderId: string,
  branchId: string,
  now: Date,
): Promise<{ businessDay: string; orderNumber: number } | null> {
  await tx.orders.lockOrderId(orderId);
  if (await tx.orders.orderExists(orderId)) return null;
  const existing = await tx.orders.findReservation(orderId);
  if (existing) {
    if (existing.branchId !== branchId) {
      throw new DomainError('IDEMPOTENCY_MISMATCH', 'This order id was already used for a different order', {
        orderId,
      });
    }
    return existing;
  }
  const branch = await tx.config.branch(branchId);
  if (!branch?.isActive) throw new DomainError('NOT_FOUND', 'Branch not found', { branchId });
  const day = businessDay(now, branch.timezone, branch.businessDayCutoff);
  const orderNumber = await tx.orders.allocateOrderNumber(branch.id, day, branch.orderNumberStart);
  await tx.orders.insertReservation({ orderId, branchId, businessDay: day, orderNumber });
  return { businessDay: day, orderNumber };
}
