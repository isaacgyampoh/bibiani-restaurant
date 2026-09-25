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

describe('Dashboard and expediter (supervisor) board', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'ops' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());

  it('Table 12 with four stations: the supervisor sees 3/4 then 4/4 ready, the late station, and hand-over', async () => {
    const waiter = await t.as(f.authUsers.waiter, f.devices.pos);
    const manager = await t.as(f.authUsers.manager);
    const order = await t.app.submitOrder.execute(waiter, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.hall,
      tableId: f.tables['12'],
      items: [
        line(f.products.jollof, 1),
        line(f.products.chicken, 1),
        line(f.products.coke, 2),
        line(f.products.birthdayCake, 1),
      ],
      send: { submissionId: uuid() },
    });
    const board = async () =>
      (await t.app.getExpoBoard.execute(manager, f.branchId)).orders.find((o) => o.id === order.id)!;

    let o = await board();
    expect(o).toMatchObject({
      orderNumber: order.orderNumber,
      tableLabel: '12',
      stationsReady: 0,
      stationsTotal: 4,
    });
    expect(o.stations.map((s) => s.stationName).sort()).toEqual([
      'Drinks',
      'Grill',
      'Main Kitchen',
      'Pastry',
    ]);
    expect(o.stations.find((s) => s.stationName === 'Drinks')!.items).toEqual([
      { name: 'Coke', quantity: 2, modifiers: [], notes: null, status: 'sent' },
    ]);

    const ticket = (name: string) => o.stations.find((s) => s.stationName === name)!.ticketId;
    for (const name of ['Main Kitchen', 'Drinks', 'Pastry'])
      await t.app.transitionTicket.execute(manager, ticket(name), { action: 'ready' });
    t.clock.advance(16 * 60); // grill target is 15 minutes
    o = await board();
    expect(o).toMatchObject({
      stationsReady: 3,
      stationsTotal: 4,
      delayed: true,
      holdingStation: 'Grill',
      canHandOver: false,
    });
    expect(o.status).toBe('partially_ready');

    const dash = await t.app.getDashboard.execute(manager, f.branchId);
    expect(dash.orders.preparing).toBeGreaterThanOrEqual(1);
    expect(dash.tables.occupied).toBeGreaterThanOrEqual(1);
    expect(dash.stations.find((s) => s.name === 'Grill')).toMatchObject({
      openTickets: 1,
      delayedTickets: 1,
    });

    await t.app.transitionTicket.execute(manager, ticket('Grill'), { action: 'ready' });
    o = await board();
    expect(o).toMatchObject({ stationsReady: 4, canHandOver: true, delayed: false, status: 'ready' });

    await t.app.fulfilOrder.execute(manager, order.id, {});
    const due = (await t.app.getOrder.execute(manager, order.id)).balanceDue;
    await t.app.recordPayment.execute(await t.as(f.authUsers.cashier, f.devices.pos), order.id, {
      paymentId: uuid(),
      method: 'momo',
      amount: due,
      reference: 'MTN-1',
    });
    expect(
      (await t.app.getExpoBoard.execute(manager, f.branchId)).orders.some((x) => x.id === order.id),
    ).toBe(false);

    const after = await t.app.getDashboard.execute(manager, f.branchId);
    expect(after.businessDay).toBe('2026-09-25');
    expect(after.sales.net).toBe(due);
    expect(after.sales.byMethod.find((m) => m.method === 'momo')).toMatchObject({ amount: due, count: 1 });
    expect(after.orders.completed).toBe(1);
    expect(after.recentOrders[0]!.id).toBe(order.id);
    expect(after.stations.find((s) => s.name === 'Grill')!.readyToday).toBe(1);
  });

  it('the dashboard needs reports permission; the board needs kitchen or order view', async () => {
    await expect(
      t.app.getDashboard.execute(await t.as(f.authUsers.cashier), f.branchId),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      t.app.getExpoBoard.execute(await t.as(f.authUsers.cashier), f.branchId),
    ).resolves.toBeTruthy(); // cashiers have order.view
    await expect(
      t.app.getExpoBoard.execute(await t.as(f.authUsers.display, f.devices.display), f.branchId),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
