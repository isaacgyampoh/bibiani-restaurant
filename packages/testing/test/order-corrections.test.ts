import { type Document, render } from '@rp/escpos';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestDatabase,
  type RestaurantFixture,
  seedRestaurant,
  type TestApp,
  type TestDatabase,
} from '../src';
import { line, uuid } from './helpers';

describe('Cancellation, voids, receipts, payment policy', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'corrections' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());

  const takeaway = async (items = [line(f.products.jollof, 1), line(f.products.meatPie, 2)]) =>
    t.app.submitOrder.execute(await t.as(f.authUsers.cashier, f.devices.pos), {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items,
      send: { submissionId: uuid() },
    });
  const jobs = (orderId: string, kind: string) =>
    db.query<{ printer_id: string; document: { blocks: { text?: string }[] }; is_reprint: boolean }>(
      'select printer_id, document, is_reprint from print_jobs where order_id = $1 and kind = $2 order by created_at',
      [orderId, kind],
    );
  const texts = (doc: { blocks: { text?: string; left?: string }[] }) =>
    doc.blocks.map((b) => b.text ?? b.left ?? '');

  it('cancelling before preparation: tickets cancelled, stations get a cancellation slip, audited; table freed', async () => {
    const waiter = await t.as(f.authUsers.waiter);
    const order = await t.app.submitOrder.execute(waiter, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.hall,
      tableId: f.tables['2']!,
      items: [line(f.products.jollof, 1), line(f.products.coke, 1)],
      send: { submissionId: uuid() },
    });
    await expect(
      t.app.cancelOrder.execute(waiter, order.id, { reason: 'Customer left' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const manager = await t.as(f.authUsers.manager);
    const view = await t.app.cancelOrder.execute(manager, order.id, { reason: 'Customer left' });
    expect(view.status).toBe('cancelled');
    expect(view.items.every((i) => i.status === 'cancelled')).toBe(true);
    expect(view.tickets.every((tk) => tk.status === 'cancelled')).toBe(true);
    const slips = await jobs(order.id, 'void_slip');
    expect(slips.map((j) => j.printer_id).sort()).toEqual([f.printers.kitchen, f.printers.drinks].sort());
    expect(texts(slips[0]!.document)).toContain('*** ORDER CANCELLED ***');
    const [table] = await db.query<{ status: string }>('select status from dining_tables where id = $1', [
      f.tables['2'],
    ]);
    expect(table!.status).toBe('available');
    const [audit] = await db.query<{ reason: string }>(
      `select reason from audit_logs where entity_id = $1 and action = 'order.cancel'`,
      [order.id],
    );
    expect(audit!.reason).toBe('Customer left');
    // Idempotent: cancelling again changes nothing.
    await t.app.cancelOrder.execute(manager, order.id, { reason: 'Customer left' });
    expect(await jobs(order.id, 'void_slip')).toHaveLength(2);
  });

  it('cancelling is refused once cooking started or money is held (void or refund instead)', async () => {
    const manager = await t.as(f.authUsers.manager);
    const started = await takeaway();
    await t.app.transitionTicket.execute(manager, started.tickets[0]!.id, { action: 'start' });
    await expect(
      t.app.cancelOrder.execute(manager, started.id, { reason: 'x changed mind' }),
    ).rejects.toMatchObject({
      code: 'PRODUCTION_STARTED',
    });
    const paid = await takeaway();
    await t.app.recordPayment.execute(manager, paid.id, { paymentId: uuid(), method: 'cash', amount: 1000 });
    await expect(
      t.app.cancelOrder.execute(manager, paid.id, { reason: 'x changed mind' }),
    ).rejects.toMatchObject({
      code: 'PAYMENTS_RECORDED',
    });
  });

  it('voiding items after cooking started: waste recorded, slip to that station only, totals drop', async () => {
    const manager = await t.as(f.authUsers.manager);
    const order = await takeaway();
    const pie = order.items.find((i) => i.name === 'Meat Pie')!;
    await t.app.transitionTicket.execute(manager, pie.ticketId!, { action: 'start' });
    const cashier = await t.as(f.authUsers.cashier);
    const requestId = uuid();
    await expect(
      t.app.voidItems.execute(cashier, order.id, {
        requestId,
        itemIds: [pie.id],
        reason: 'Dropped on floor',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const view = await t.app.voidItems.execute(manager, order.id, {
      requestId,
      itemIds: [pie.id],
      reason: 'Dropped on floor',
    });
    expect(view.items.find((i) => i.id === pie.id)!.status).toBe('voided');
    expect(view.grandTotal).toBe(order.grandTotal - pie.lineTotal);
    expect(view.tickets.find((tk) => tk.id === pie.ticketId)!.status).toBe('cancelled');
    const slips = await jobs(order.id, 'void_slip');
    expect(slips.map((s) => s.printer_id)).toEqual([f.printers.pastry]);
    expect(texts(slips[0]!.document)).toContain('DO NOT MAKE: 2 x MEAT PIE');
    const [row] = await db.query<{
      void_reason: string;
      voided_by_staff_id: string | null;
      voided_at: Date | null;
    }>('select void_reason, voided_by_staff_id, voided_at from order_items where id = $1', [pie.id]);
    expect(row).toMatchObject({ void_reason: 'Dropped on floor' });
    expect(row!.voided_by_staff_id).not.toBeNull();
    expect(row!.voided_at).not.toBeNull();
    // Replay of the same void request prints nothing new.
    await t.app.voidItems.execute(manager, order.id, {
      requestId,
      itemIds: [pie.id],
      reason: 'Dropped on floor',
    });
    expect(await jobs(order.id, 'void_slip')).toHaveLength(1);
  });

  it('voiding every item voids the order', async () => {
    const manager = await t.as(f.authUsers.manager);
    const order = await takeaway([line(f.products.coke, 1)]);
    const view = await t.app.voidItems.execute(manager, order.id, {
      requestId: uuid(),
      itemIds: [order.items[0]!.id],
      reason: 'Wrong order',
    });
    expect(view.status).toBe('voided');
  });

  it('receipt: original then audited REPRINT on the till receipt printer; retries print once; sale unchanged', async () => {
    const cashier = await t.as(f.authUsers.cashier, f.devices.pos);
    const order = await takeaway();
    await t.app.recordPayment.execute(cashier, order.id, {
      paymentId: uuid(),
      method: 'cash',
      tendered: 20000,
    });
    const first = { requestId: uuid() };
    const a = await t.app.printReceipt.execute(cashier, order.id, first);
    const aAgain = await t.app.printReceipt.execute(cashier, order.id, first);
    expect(aAgain.printJobId).toBe(a.printJobId);
    expect(a.isReprint).toBe(false);
    const b = await t.app.printReceipt.execute(cashier, order.id, { requestId: uuid() });
    expect(b.isReprint).toBe(true);

    const receipts = await jobs(order.id, 'receipt');
    expect(receipts).toHaveLength(2);
    expect(receipts.every((r) => r.printer_id === f.printers.receipt)).toBe(true);
    const lines = texts(receipts[0]!.document);
    expect(lines).toEqual(
      expect.arrayContaining([`ORDER #${order.orderNumber}`, 'TOTAL', 'CASH', '  Change']),
    );
    expect(lines.some((l) => l.startsWith('incl. Standard tax 15%'))).toBe(true);
    expect(
      await db.query(`select 1 from audit_logs where entity_id = $1 and action = 'receipt.reprint'`, [
        order.id,
      ]),
    ).toHaveLength(1);
    const after = await t.app.getOrder.execute(cashier, order.id);
    expect(after.payments).toHaveLength(1);
    expect(after.grandTotal).toBe(order.grandTotal);

    const onScreen = await t.app.getReceipt.execute(cashier, order.id);
    expect(onScreen.document.title).toBe(`Receipt #${order.orderNumber}`);
  });

  it('completed order: listed under recent closed orders; reprint is audited and changes nothing else', async () => {
    const cashier = await t.as(f.authUsers.cashier, f.devices.pos);
    const manager = await t.as(f.authUsers.manager);
    const order = await takeaway([line(f.products.coke, 2)]);
    await t.app.recordPayment.execute(cashier, order.id, {
      paymentId: uuid(),
      method: 'momo',
      amount: order.grandTotal,
    });
    await t.app.printReceipt.execute(cashier, order.id, { requestId: uuid() }); // original at payment
    await t.app.markOrderReady.execute(manager, order.id);
    const done = await t.app.fulfilOrder.execute(manager, order.id, {});
    expect(done.status).toBe('completed');

    const closed = await t.app.listRecentClosedOrders.execute(cashier, f.branchId);
    expect(closed.find((o) => o.id === order.id)).toMatchObject({
      status: 'completed',
      paymentStatus: 'paid',
    });
    expect((await t.app.listActiveOrders.execute(cashier, f.branchId)).some((o) => o.id === order.id)).toBe(
      false,
    );

    const state = async () =>
      (
        await db.query<Record<string, unknown>>(
          `select o.status, o.payment_status, o.version, o.grand_total, o.paid_total,
                  (select count(*) from payments p where p.order_id = o.id)::int as payments,
                  (select count(*) from orders x where x.branch_id = o.branch_id)::int as orders
             from orders o where o.id = $1`,
          [order.id],
        )
      )[0];
    const before = await state();
    const reprint = await t.app.printReceipt.execute(cashier, order.id, { requestId: uuid() });
    expect(reprint.isReprint).toBe(true);
    expect(await state()).toEqual(before); // not reopened, no payment, no new sale
    const receipts = await jobs(order.id, 'receipt');
    expect(receipts.at(-1)!.is_reprint).toBe(true);
    const printed = render(receipts.at(-1)!.document as unknown as Document, {
      paperWidthMm: 80,
      isReprint: receipts.at(-1)!.is_reprint,
    }); // exactly what the print agent sends to the printer
    expect(Buffer.from(printed).toString('latin1')).toContain('** REPRINT **');
    expect(
      await db.query(`select 1 from audit_logs where entity_id = $1 and action = 'receipt.reprint'`, [
        order.id,
      ]),
    ).toHaveLength(1);

    await expect(
      t.app.printReceipt.execute(await t.as(f.authUsers.kitchenKds), order.id, {
        requestId: uuid(),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('payment policy: pay-before-fulfilment blocks handover until settled; pay-after allows it', async () => {
    const manager = await t.as(f.authUsers.manager);
    await db.query(`update operational_areas set payment_policy = 'pay_before_fulfillment' where id = $1`, [
      f.areas.takeaway,
    ]);
    const order = await takeaway([line(f.products.coke, 1)]);
    await t.app.markOrderReady.execute(manager, order.id);
    await expect(t.app.fulfilOrder.execute(manager, order.id, {})).rejects.toMatchObject({
      code: 'PAYMENT_REQUIRED_BEFORE_FULFILMENT',
    });
    await t.app.recordPayment.execute(manager, order.id, {
      paymentId: uuid(),
      method: 'momo',
      amount: order.grandTotal,
    });
    expect((await t.app.fulfilOrder.execute(manager, order.id, {})).status).toBe('completed');

    await db.query(`update operational_areas set payment_policy = 'pay_after_fulfillment' where id = $1`, [
      f.areas.takeaway,
    ]);
    const later = await takeaway([line(f.products.coke, 1)]);
    await t.app.markOrderReady.execute(manager, later.id);
    expect((await t.app.fulfilOrder.execute(manager, later.id, {})).status).toBe('picked_up');
  });

  it('mark ready needs kitchen permission', async () => {
    const order = await takeaway([line(f.products.coke, 1)]);
    await expect(
      t.app.markOrderReady.execute(await t.as(f.authUsers.cashier), order.id),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('hall floor shows occupied, ready to serve and awaiting payment from real order state', async () => {
    const waiter = await t.as(f.authUsers.waiter);
    const manager = await t.as(f.authUsers.manager);
    const order = await t.app.submitOrder.execute(waiter, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.hall,
      tableId: f.tables['1']!,
      items: [line(f.products.coke, 1)],
      send: { submissionId: uuid() },
    });
    const state = async () =>
      (await t.app.getFloor.execute(waiter, f.branchId)).tables.find((x) => x.label === '1')!;
    expect((await state()).state).toBe('occupied');
    await t.app.markOrderReady.execute(manager, order.id);
    expect((await state()).state).toBe('ready_to_serve');
    await t.app.fulfilOrder.execute(waiter, order.id, {});
    expect((await state()).state).toBe('awaiting_payment');
    await t.app.recordPayment.execute(manager, order.id, {
      paymentId: uuid(),
      method: 'card',
      amount: order.grandTotal,
    });
    expect((await state()).state).toBe('cleaning');
    await t.app.setTableStatus.execute(waiter, f.tables['1']!, { status: 'available' });
    expect((await state()).state).toBe('available');
  });
});
