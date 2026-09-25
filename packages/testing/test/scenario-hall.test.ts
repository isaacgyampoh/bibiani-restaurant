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

// Milestone Scenario A: Table 12, four stations, KDS, printing, payment, completion.
describe('Scenario A — Hall, Table 12', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'bibiani', orderNumberStart: 5001 });
    t = createTestApp(db);
  });
  afterAll(() => db.close());

  it('routes one order to four stations, becomes READY when all stations are ready, then completes on payment', async () => {
    const waiter = await t.as(f.authUsers.waiter, f.devices.pos);
    const orderId = uuid();
    const order = await t.app.submitOrder.execute(waiter, {
      orderId,
      branchId: f.branchId,
      areaId: f.areas.hall,
      tableId: f.tables['12']!,
      items: [
        line(f.products.jollof, 2, { modifierIds: [f.modifiers.noPepper] }),
        line(f.products.chicken, 2),
        line(f.products.meatPie, 2),
        line(f.products.coke, 2),
      ],
      send: { submissionId: uuid() },
    });

    // One customer order, human number 5001, internal UUID id.
    expect(order.id).toBe(orderId);
    expect(order.orderNumber).toBe(5001);
    expect(order.table?.label).toBe('12');
    expect(order.status).toBe('submitted');
    expect(order.paymentStatus).toBe('unpaid');
    expect(order.grandTotal).toBe(2 * 4500 + 2 * 6000 + 2 * 1500 + 2 * 1000);

    // Four tickets, one per station, each holding only its items and the parent order.
    const byStation = Object.fromEntries(order.tickets.map((tk) => [tk.stationName, tk]));
    expect(Object.keys(byStation).sort()).toEqual(['Drinks', 'Grill', 'Main Kitchen', 'Pastry']);
    const nameOf = (id: string) => order.items.find((i) => i.id === id)!.name;
    expect(byStation['Main Kitchen']!.itemIds.map(nameOf)).toEqual(['Jollof Rice']);
    expect(byStation.Grill!.itemIds.map(nameOf)).toEqual(['Grilled Chicken']);
    expect(byStation.Pastry!.itemIds.map(nameOf)).toEqual(['Meat Pie']);
    expect(byStation.Drinks!.itemIds.map(nameOf)).toEqual(['Coke']);

    // One print job per ticket, on that station's printer.
    const expectedPrinter = {
      'Main Kitchen': f.printers.kitchen,
      Grill: f.printers.grill,
      Pastry: f.printers.pastry,
      Drinks: f.printers.drinks,
    } as Record<string, string>;
    for (const tk of order.tickets) {
      expect(tk.printJobs).toHaveLength(1);
      expect(tk.printJobs[0]!.printerId).toBe(expectedPrinter[tk.stationName]);
      expect(tk.printJobs[0]!.status).toBe('pending');
    }

    // Kitchen KDS sees only its own ticket, with the order context.
    const kitchenKds = await t.as(f.authUsers.kitchenKds);
    const board = await t.app.getStationBoard.execute(kitchenKds, f.stations.kitchen);
    expect(board.tickets).toHaveLength(1);
    expect(board.tickets[0]).toMatchObject({
      orderNumber: 5001,
      channel: 'dine_in',
      tableLabel: '12',
      items: [{ quantity: 2, name: 'JOLLOF', modifiers: ['NO PEPPER'] }],
    });

    // Stations finish one by one: order goes partially ready, then ready.
    const manager = await t.as(f.authUsers.manager);
    const ticketOf = (station: string) => order.tickets.find((tk) => tk.stationName === station)!.id;
    await t.app.transitionTicket.execute(kitchenKds, ticketOf('Main Kitchen'), { action: 'start' });
    let view = await t.app.transitionTicket.execute(kitchenKds, ticketOf('Main Kitchen'), {
      action: 'ready',
    });
    expect(view.status).toBe('partially_ready');
    await t.app.transitionTicket.execute(manager, ticketOf('Grill'), { action: 'ready' });
    await t.app.transitionTicket.execute(manager, ticketOf('Pastry'), { action: 'ready' });
    view = await t.app.transitionTicket.execute(manager, ticketOf('Drinks'), { action: 'ready' });
    expect(view.status).toBe('ready');
    expect(view.readyAt).not.toBeNull();

    // Kitchen readiness is not payment: still unpaid.
    expect(view.paymentStatus).toBe('unpaid');

    // Customer display shows 5001 READY (numbers only).
    const display = await t.as(f.authUsers.display);
    const customerBoard = await t.app.getCustomerBoard.execute(display, f.branchId);
    expect(customerBoard.ready).toEqual([{ orderNumber: 5001, channel: 'dine_in' }]);
    expect(customerBoard.preparing).toEqual([]);

    // Waiter serves the table.
    view = await t.app.fulfilOrder.execute(waiter, orderId, {});
    expect(view.status).toBe('served');
    expect(view.tickets.every((tk) => tk.status === 'completed')).toBe(true);

    // Split payment: cash 150.00 then MoMo for the rest.
    const cashier = await t.as(f.authUsers.cashier, f.devices.pos);
    view = await t.app.recordPayment.execute(cashier, orderId, {
      paymentId: uuid(),
      method: 'cash',
      amount: 15000,
      tendered: 20000,
    });
    expect(view.paymentStatus).toBe('partially_paid');
    expect(view.status).toBe('served');
    expect(view.balanceDue).toBe(26000 - 15000);
    expect(view.payments[0]).toMatchObject({
      method: 'cash',
      amount: 15000,
      tenderedAmount: 20000,
      changeAmount: 5000,
    });

    view = await t.app.recordPayment.execute(cashier, orderId, {
      paymentId: uuid(),
      method: 'momo',
      amount: 11000,
      reference: 'MOMO-TX-778812',
    });
    expect(view.paymentStatus).toBe('paid');
    expect(view.status).toBe('completed');
    expect(view.completedAt).not.toBeNull();

    // Table released for cleaning; audit trail written for both payments.
    const [table] = await db.query<{ status: string }>('select status from dining_tables where id = $1', [
      f.tables['12'],
    ]);
    expect(table!.status).toBe('cleaning');
    const audits = await db.query<{ action: string }>(
      `select action from audit_logs where restaurant_id = $1 and entity_type = 'payment' order by id`,
      [f.restaurantId],
    );
    expect(audits.map((a) => a.action)).toEqual(['payment.record', 'payment.record']);
  });
});
