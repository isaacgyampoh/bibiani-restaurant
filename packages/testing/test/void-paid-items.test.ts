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
 * Production (found while preparing the server migration, 2026-11-11): two fully paid orders had
 * every item voided, leaving GHS 0 orders with GHS 150 and GHS 200 still recorded as received and no
 * refund. Voiding paid items now requires the refund to be recorded first.
 */
describe('voiding items of a paid order', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'void-paid' });
    t = createTestApp(db);
  });
  afterAll(async () => {
    await db.close();
  });

  async function paidOrder() {
    const cashier = await t.as(f.authUsers.cashier, f.devices.pos);
    const orderId = uuid();
    const order = await t.app.submitOrder.execute(cashier, {
      orderId,
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      customerName: 'Ama',
      items: [line(f.products.coke, 2)],
      send: { submissionId: uuid() },
    });
    const paymentId = uuid();
    await t.app.recordPayment.execute(cashier, orderId, {
      paymentId,
      method: 'cash',
      tendered: order.grandTotal,
    });
    return { order, paymentId };
  }

  it('is refused while the money is still recorded, and nothing changes', async () => {
    const { order } = await paidOrder();
    const manager = await t.as(f.authUsers.manager);
    await expect(
      t.app.voidItems.execute(manager, order.id, {
        requestId: uuid(),
        itemIds: order.items.map((i) => i.id),
        reason: 'Customer changed mind',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENTS_RECORDED', details: { refundNeeded: order.grandTotal } });
    const after = await t.app.getOrder.execute(manager, order.id);
    expect(after.items.every((i) => i.status !== 'voided')).toBe(true);
    expect(after.grandTotal).toBe(order.grandTotal);
  });

  it('works once the refund is recorded; the books balance', async () => {
    const { order, paymentId } = await paidOrder();
    const manager = await t.as(f.authUsers.manager);
    await t.app.refundPayment.execute(manager, paymentId, {
      refundId: uuid(),
      amount: order.grandTotal,
      reason: 'Customer changed mind',
    });
    const v = await t.app.voidItems.execute(manager, order.id, {
      requestId: uuid(),
      itemIds: order.items.map((i) => i.id),
      reason: 'Customer changed mind',
    });
    expect(v.grandTotal).toBe(0);
    expect(v.paidTotal - v.refundedTotal).toBe(0);
  });

  it('a partial void that leaves the order worth at least what was paid is still allowed', async () => {
    const cashier = await t.as(f.authUsers.cashier, f.devices.pos);
    const orderId = uuid();
    const order = await t.app.submitOrder.execute(cashier, {
      orderId,
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      customerName: 'Kofi',
      items: [line(f.products.coke, 1), line(f.products.jollof, 1)],
      send: { submissionId: uuid() },
    });
    const coke = order.items.find((i) => i.productId === f.products.coke)!;
    await t.app.recordPayment.execute(cashier, orderId, {
      paymentId: uuid(),
      method: 'cash',
      tendered: order.grandTotal - coke.lineTotal,
      amount: order.grandTotal - coke.lineTotal,
    });
    const v = await t.app.voidItems.execute(await t.as(f.authUsers.manager), orderId, {
      requestId: uuid(),
      itemIds: [coke.id],
      reason: 'Out of stock',
    });
    expect(v.paidTotal).toBe(v.grandTotal);
  });
});
