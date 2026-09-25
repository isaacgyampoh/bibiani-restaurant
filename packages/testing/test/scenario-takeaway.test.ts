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

// Milestone Scenario B and TEST 10 (per-item routing correctness).
describe('Scenario B — Takeaway #5002', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'takeaway', orderNumberStart: 5001 });
    t = createTestApp(db);
    // #5001 is the hall order of the day; the takeaway becomes #5002.
    const waiter = await t.as(f.authUsers.waiter);
    await t.app.submitOrder.execute(waiter, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.hall,
      tableId: f.tables['12']!,
      items: [line(f.products.jollof, 2)],
      send: { submissionId: uuid() },
    });
  });
  afterAll(() => db.close());

  it('routes cake + pies to Pastry, sandwich to Kitchen, cokes to Drinks; ready for pickup; paid; picked up', async () => {
    const cashier = await t.as(f.authUsers.cashier, f.devices.pos);
    const items = [
      line(f.products.birthdayCake, 1),
      line(f.products.meatPie, 2),
      line(f.products.sandwich, 1),
      line(f.products.coke, 2),
    ];
    const order = await t.app.submitOrder.execute(cashier, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      customerName: 'Kwame Mensah',
      customerPhone: '0240000000',
      items,
      send: { submissionId: uuid() },
    });
    expect(order.orderNumber).toBe(5002);
    expect(order.channel).toBe('takeaway');

    // TEST 10: every item on the right station (category tree walk + product override).
    const stationOf = (itemId: string) => order.items.find((i) => i.id === itemId)!.stationId;
    expect(stationOf(items[0]!.id)).toBe(f.stations.pastry); // product rule
    expect(stationOf(items[1]!.id)).toBe(f.stations.pastry); // category rule
    expect(stationOf(items[2]!.id)).toBe(f.stations.kitchen); // Sandwiches -> Food (parent) rule
    expect(stationOf(items[3]!.id)).toBe(f.stations.drinks);
    expect(order.tickets.map((tk) => tk.stationName).sort()).toEqual(['Drinks', 'Main Kitchen', 'Pastry']);

    // Pastry ticket prints on the pastry printer AND the extra cake printer (product override).
    const pastry = order.tickets.find((tk) => tk.stationName === 'Pastry')!;
    expect(pastry.itemIds).toEqual([items[0]!.id, items[1]!.id]);
    expect(pastry.printJobs.map((j) => j.printerId).sort()).toEqual(
      [f.printers.pastry, f.printers.pastry2].sort(),
    );

    // Takeaway paid up front (pay-now at the counter). Payment does not change kitchen state.
    let view = await t.app.recordPayment.execute(cashier, order.id, {
      paymentId: uuid(),
      method: 'card',
      amount: order.grandTotal,
    });
    expect(view.paymentStatus).toBe('paid');
    expect(view.status).toBe('submitted');

    const display = await t.as(f.authUsers.display);
    let board = await t.app.getCustomerBoard.execute(display, f.branchId);
    expect(board.preparing).toContainEqual({ orderNumber: 5002, channel: 'takeaway' });

    const manager = await t.as(f.authUsers.manager);
    for (const tk of view.tickets)
      view = await t.app.transitionTicket.execute(manager, tk.id, { action: 'ready' });
    expect(view.status).toBe('ready');
    board = await t.app.getCustomerBoard.execute(display, f.branchId);
    expect(board.ready).toContainEqual({ orderNumber: 5002, channel: 'takeaway' });

    // Handed over: paid + picked up = completed, and it leaves the customer board.
    view = await t.app.fulfilOrder.execute(cashier, order.id, {});
    expect(view.status).toBe('completed');
    board = await t.app.getCustomerBoard.execute(display, f.branchId);
    expect(board.ready.some((e) => e.orderNumber === 5002)).toBe(false);
  });

  it('an unpaid takeaway that is picked up is PICKED_UP, not COMPLETED', async () => {
    const cashier = await t.as(f.authUsers.cashier);
    const order = await t.app.submitOrder.execute(cashier, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(f.products.coke, 1)],
      send: { submissionId: uuid() },
    });
    const manager = await t.as(f.authUsers.manager);
    await t.app.transitionTicket.execute(manager, order.tickets[0]!.id, { action: 'ready' });
    const view = await t.app.fulfilOrder.execute(cashier, order.id, {});
    expect(view.status).toBe('picked_up');
    expect(view.paymentStatus).toBe('unpaid');
  });
});
