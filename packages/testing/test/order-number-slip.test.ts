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
 * Owner's request, 2026-09-30: when an order is printed to the kitchen, the customer's order number
 * is printed too: on the till's receipt printer, once per order, per area (on by default).
 */
describe('order number slip for the customer', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'order-slip' });
    t = createTestApp(db);
  });
  afterAll(async () => {
    await db.close();
  });

  const slips = (orderId: string) =>
    db.query<{ printer_id: string; document: { blocks: { text?: string }[] } }>(
      `select printer_id, document from print_jobs where order_id = $1 and kind = 'order_number'`,
      [orderId],
    );

  it('first send: one slip with the order number on the till’s receipt printer; more items later print none', async () => {
    const cashier = await t.as(f.authUsers.cashier, f.devices.pos);
    const orderId = uuid();
    const base = { orderId, branchId: f.branchId, areaId: f.areas.takeaway, customerName: 'Ama' };
    const order = await t.app.submitOrder.execute(cashier, {
      ...base,
      items: [line(f.products.coke, 1)],
      send: { submissionId: uuid() },
    });
    const [slip, ...more] = await slips(orderId);
    expect(more).toHaveLength(0);
    expect(slip!.printer_id).toBe(f.printers.receipt);
    const texts = slip!.document.blocks.map((b) => b.text);
    expect(texts).toContain('YOUR ORDER NUMBER');
    expect(texts).toContain(`#${order.orderNumber}`);
    expect(texts).toContain('Takeaway - Ama');

    await t.app.submitOrder.execute(cashier, {
      ...base,
      items: [line(f.products.coke, 2)],
      send: { submissionId: uuid() },
    });
    expect(await slips(orderId)).toHaveLength(1);
    // The kitchen still gets its tickets as before.
    const [{ n }] = (await db.query<{ n: number }>(
      `select count(*)::int as n from print_jobs where order_id = $1 and kind = 'kitchen_ticket'`,
      [orderId],
    )) as [{ n: number }];
    expect(n).toBeGreaterThan(0);
  });

  it('turned off for the area: no slip', async () => {
    await db.query('update operational_areas set print_order_number = false where id = $1', [
      f.areas.takeaway,
    ]);
    const cashier = await t.as(f.authUsers.cashier, f.devices.pos);
    const orderId = uuid();
    await t.app.submitOrder.execute(cashier, {
      orderId,
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      customerName: 'Kofi',
      items: [line(f.products.coke, 1)],
      send: { submissionId: uuid() },
    });
    expect(await slips(orderId)).toHaveLength(0);
    await db.query('update operational_areas set print_order_number = true where id = $1', [
      f.areas.takeaway,
    ]);
  });

  it('a device without a receipt printer: the order goes to the kitchen, no slip', async () => {
    const cashier = await t.as(f.authUsers.cashier);
    const orderId = uuid();
    const order = await t.app.submitOrder.execute(cashier, {
      orderId,
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      customerName: 'Esi',
      items: [line(f.products.coke, 1)],
      send: { submissionId: uuid() },
    });
    expect(order.status).not.toBe('draft');
    expect(await slips(orderId)).toHaveLength(0);
  });
});
