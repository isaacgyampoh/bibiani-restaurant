import type { SubmitOrderCommand } from '@rp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestDatabase,
  HOSTED,
  type RestaurantFixture,
  seedRestaurant,
  type TestApp,
  type TestDatabase,
} from '../src';
import { line, uuid } from './helpers';

const count = async (db: TestDatabase, table: string, where: string, params: unknown[]) =>
  Number(
    (await db.query<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, params))[0]!.n,
  );

describe('Idempotency: the client retries because it never saw the response', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'idem' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());

  const takeawayOrder = (): SubmitOrderCommand => ({
    orderId: uuid(),
    branchId: f.branchId,
    areaId: f.areas.takeaway,
    items: [line(f.products.jollof, 1), line(f.products.coke, 1)],
    send: { submissionId: uuid() },
  });

  it('TEST 3 — retrying the same order creates no duplicate order, items or number', async () => {
    const cashier = await t.as(f.authUsers.cashier);
    const cmd = takeawayOrder();
    const first = await t.app.submitOrder.execute(cashier, cmd);
    const retries = await Promise.all([1, 2, 3].map(() => t.app.submitOrder.execute(cashier, cmd)));

    for (const r of retries) {
      expect(r.id).toBe(first.id);
      expect(r.orderNumber).toBe(first.orderNumber);
      expect(r.tickets.map((tk) => tk.id).sort()).toEqual(first.tickets.map((tk) => tk.id).sort());
    }
    expect(await count(db, 'orders', 'id = $1', [cmd.orderId])).toBe(1);
    expect(await count(db, 'order_items', 'order_id = $1', [cmd.orderId])).toBe(2);
    // No order number was burned by the retries.
    const next = await t.app.submitOrder.execute(cashier, takeawayOrder());
    expect(next.orderNumber).toBe(first.orderNumber + 1);
  });

  it('TEST 4 — retrying the same send-to-kitchen creates no duplicate tickets or print jobs', async () => {
    const cashier = await t.as(f.authUsers.cashier);
    const cmd = takeawayOrder();
    await t.app.submitOrder.execute(cashier, cmd);
    // 50 locally; 10 against hosted DEV (each replay is seconds away from this test machine).
    for (let i = 0; i < (HOSTED ? 10 : 50); i++) await t.app.submitOrder.execute(cashier, cmd);

    expect(await count(db, 'order_submissions', 'order_id = $1', [cmd.orderId])).toBe(1);
    expect(await count(db, 'production_tickets', 'order_id = $1', [cmd.orderId])).toBe(2);
    expect(await count(db, 'print_jobs', 'order_id = $1', [cmd.orderId])).toBe(2);
  });

  it('a second round on the same table gets new tickets only for the new items', async () => {
    const waiter = await t.as(f.authUsers.waiter);
    const orderId = uuid();
    const base = { orderId, branchId: f.branchId, areaId: f.areas.hall, tableId: f.tables['1']! };
    const round1 = await t.app.submitOrder.execute(waiter, {
      ...base,
      items: [line(f.products.jollof, 1)],
      send: { submissionId: uuid() },
    });
    const round2Items = [line(f.products.coke, 2)];
    const round2 = { ...base, items: round2Items, send: { submissionId: uuid() } };
    const after = await t.app.submitOrder.execute(waiter, round2);
    await t.app.submitOrder.execute(waiter, round2); // retry of round 2

    expect(after.id).toBe(round1.id);
    expect(after.tickets).toHaveLength(2);
    const newTicket = after.tickets.find((tk) => !round1.tickets.some((o) => o.id === tk.id))!;
    expect(newTicket.stationName).toBe('Drinks');
    expect(newTicket.itemIds).toEqual([round2Items[0]!.id]);
    expect(await count(db, 'production_tickets', 'order_id = $1', [orderId])).toBe(2);
  });

  it('reusing an id for a DIFFERENT request is rejected instead of silently merged', async () => {
    const cashier = await t.as(f.authUsers.cashier);
    const cmd = takeawayOrder();
    await t.app.submitOrder.execute(cashier, cmd);
    const changedItem = { ...cmd, items: [{ ...cmd.items[0]!, quantity: 5 }, cmd.items[1]!] };
    await expect(t.app.submitOrder.execute(cashier, changedItem)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_MISMATCH',
    });
    await expect(
      t.app.submitOrder.execute(cashier, { ...cmd, customerName: 'Someone else' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });

  it('TEST 9 — retrying the same payment records exactly one payment', async () => {
    const cashier = await t.as(f.authUsers.cashier);
    const cmd = takeawayOrder();
    const order = await t.app.submitOrder.execute(cashier, cmd);
    const payment = { paymentId: uuid(), method: 'cash' as const, tendered: 10000 };
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => t.app.recordPayment.execute(cashier, order.id, payment)),
    );

    expect(await count(db, 'payments', 'order_id = $1', [order.id])).toBe(1);
    for (const r of results) {
      expect(r.payments).toHaveLength(1);
      expect(r.paidTotal).toBe(order.grandTotal);
      expect(r.paymentStatus).toBe('paid');
    }
    await expect(
      t.app.recordPayment.execute(cashier, order.id, { ...payment, tendered: 99999 }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });
});
