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

/**
 * "Please bring me my bill": the waiter prints the bill, the customer pays the cashier, the order
 * becomes PAID. A bill is a printout of the open order; it never creates payments, stock movements
 * or orders.
 */
describe('Bill request and settlement', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'bills' });
    t = createTestApp(db);
    // One table per scenario.
    const [{ area_id }] = (await db.query<{ area_id: string }>(
      'select area_id from dining_tables where id = $1',
      [f.tables['1']],
    )) as [{ area_id: string }];
    for (const label of ['B1', 'B2', 'B3', 'B4', 'B5']) {
      const [{ id }] = (await db.query<{ id: string }>(
        `insert into dining_tables (restaurant_id, branch_id, area_id, label) values ($1, $2, $3, $4) returning id`,
        [f.restaurantId, f.branchId, area_id, label],
      )) as [{ id: string }];
      tables.push(id);
    }
  });
  afterAll(() => db.close());

  const count = async (sql: string, params: unknown[] = []) =>
    (await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params))[0]!.n;

  /** A dine-in table order (pay after eating): 2 x Jollof (45.00) + 1 Coke (10.00) = 100.00. */
  const tables: string[] = [];
  let nextTable = 0;
  async function tableOrder() {
    const waiter = await t.as(f.authUsers.waiter, f.devices.pos);
    const order = await t.app.submitOrder.execute(waiter, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.dining,
      tableId: tables[nextTable++],
      items: [line(f.products.jollof, 2), line(f.products.coke, 1)],
      send: { submissionId: uuid() },
    });
    return { waiter, order };
  }

  it('the waiter prints the bill: BILL, NOT PAID, amount due; no payment, stock or order is created', async () => {
    const { waiter, order } = await tableOrder();
    const before = {
      orders: await count('orders'),
      payments: await count('payments'),
      movements: await count('stock_movements'),
    };
    const requestId = uuid();
    const bill = await t.app.requestBill.execute(waiter, order.id, { requestId });
    expect(bill.printJobId).not.toBeNull();
    expect(bill.copy).toBe(false);

    const [job] = await db.query<{
      kind: string;
      document: { blocks: { text?: string; left?: string; right?: string }[] };
    }>('select kind, document from print_jobs where id = $1', [bill.printJobId]);
    expect(job!.kind).toBe('bill');
    const texts = job!.document.blocks.map((b) => b.text ?? `${b.left ?? ''} ${b.right ?? ''}`);
    expect(texts).toContain('BILL');
    expect(texts).toContain('NOT PAID');
    expect(
      texts.some(
        (x) => x.startsWith('AMOUNT DUE') && x.includes(String((order.grandTotal / 100).toFixed(2))),
      ),
    ).toBe(true);
    expect(texts).toContain('This is a bill, not a receipt.');
    expect(texts.some((x) => x.includes('2 x Jollof Rice'))).toBe(true);

    // Nothing else changed.
    expect({
      orders: await count('orders'),
      payments: await count('payments'),
      movements: await count('stock_movements'),
    }).toEqual(before);
    const view = await t.app.getOrder.execute(waiter, order.id);
    expect(view.bill).toMatchObject({ status: 'printed', prints: 1 });
    expect(view.paymentStatus).toBe('unpaid');

    // The same request again (network retry) prints nothing more.
    await t.app.requestBill.execute(waiter, order.id, { requestId });
    expect(await count(`print_jobs where order_id = $1 and kind = 'bill'`, [order.id])).toBe(1);

    // Another copy is marked BILL / COPY and audited as a copy.
    const copy = await t.app.requestBill.execute(waiter, order.id, { requestId: uuid() });
    expect(copy.copy).toBe(true);
    const [copyJob] = await db.query<{ document: { blocks: { text?: string }[] } }>(
      'select document from print_jobs where id = $1',
      [copy.printJobId],
    );
    expect(copyJob!.document.blocks.some((b) => b.text === 'BILL / COPY')).toBe(true);
    expect(await count(`audit_logs where entity_id = $1 and action = 'order.bill_copy'`, [order.id])).toBe(1);
  });

  it('the cashier settles the bill in cash: amount, change, audit; the order becomes PAID', async () => {
    const { order } = await tableOrder();
    const cashier = await t.as(f.authUsers.cashier, f.devices.pos);
    await t.app.requestBill.execute(cashier, order.id, { requestId: uuid() });
    const paid = await t.app.recordPayment.execute(cashier, order.id, {
      paymentId: uuid(),
      method: 'cash',
      tendered: order.grandTotal + 5000,
    });
    expect(paid.paymentStatus).toBe('paid');
    expect(paid.bill.status).toBe('paid');
    // Settlement audit: order, cashier, device, method, amount, change (who, where, what, when).
    const [audit] = await db.query<{ actor_device_id: string | null; after_data: Record<string, unknown> }>(
      `select actor_device_id, after_data from audit_logs where action = 'payment.record' and after_data->>'orderId' = $1`,
      [order.id],
    );
    expect(audit).toBeDefined();
    expect(audit!.actor_device_id).toBe(f.devices.pos);
    expect(audit!.after_data).toMatchObject({ method: 'cash', amount: order.grandTotal, change: 5000 });

    // PAID is final: no bill, no second payment.
    await expect(t.app.requestBill.execute(cashier, order.id, { requestId: uuid() })).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await expect(
      t.app.recordPayment.execute(cashier, order.id, { paymentId: uuid(), method: 'cash', tendered: 1000 }),
    ).rejects.toBeTruthy();
  });

  it('part-paid: the bill shows what is still due; MoMo is recorded by the cashier with its reference', async () => {
    const { order } = await tableOrder();
    const cashier = await t.as(f.authUsers.cashier, f.devices.pos);
    await t.app.recordPayment.execute(cashier, order.id, { paymentId: uuid(), method: 'cash', amount: 4000 });
    const bill = await t.app.getBill.execute(cashier, order.id);
    const due = bill.document.blocks.find((b) => b.type === 'columns' && b.left === 'AMOUNT DUE');
    expect(due && 'right' in due ? due.right : '').toContain(((order.grandTotal - 4000) / 100).toFixed(2));
    const done = await t.app.recordPayment.execute(cashier, order.id, {
      paymentId: uuid(),
      method: 'momo',
      amount: order.grandTotal - 4000,
      reference: 'MTN-778899',
    });
    expect(done.paymentStatus).toBe('paid');
    expect(done.payments.find((p) => p.method === 'momo')).toMatchObject({ reference: 'MTN-778899' });
  });

  it('no printer on this device: the bill is marked requested and shown on screen', async () => {
    const { order } = await tableOrder();
    const waiter = await t.as(f.authUsers.waiter); // not operating a till with a receipt printer
    const result = await t.app.requestBill.execute(waiter, order.id, { requestId: uuid() });
    expect(result.printJobId).toBeNull();
    expect((await t.app.getOrder.execute(waiter, order.id)).bill.status).toBe('requested');
    const onScreen = await t.app.getBill.execute(waiter, order.id);
    expect(onScreen.document.title).toBe(`Bill #${order.orderNumber}`);
  });

  it('a cancelled order has no bill; kitchen staff cannot request bills', async () => {
    const { order } = await tableOrder();
    const manager = await t.as(f.authUsers.manager);
    await expect(
      t.app.requestBill.execute(await t.as(f.authUsers.kitchenKds), order.id, { requestId: uuid() }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await t.app.cancelOrder.execute(manager, order.id, { reason: 'Customer left' });
    await expect(t.app.requestBill.execute(manager, order.id, { requestId: uuid() })).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    expect((await t.app.getOrder.execute(manager, order.id)).bill.status).toBe('cancelled');
  });
});
