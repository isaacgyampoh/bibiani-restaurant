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

describe('Kitchen operations', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'kitchen' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());

  async function twoStationOrder() {
    const cashier = await t.as(f.authUsers.cashier);
    return t.app.submitOrder.execute(cashier, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(f.products.jollof, 1), line(f.products.meatPie, 1)],
      send: { submissionId: uuid() },
    });
  }

  it('full ticket lifecycle with pause and recall moves the order status accordingly', async () => {
    const order = await twoStationOrder();
    const kds = await t.as(f.authUsers.kitchenKds);
    const kitchen = order.tickets.find((tk) => tk.stationId === f.stations.kitchen)!;
    const pastry = order.tickets.find((tk) => tk.stationId === f.stations.pastry)!;

    let v = await t.app.transitionTicket.execute(kds, kitchen.id, { action: 'accept' });
    expect(v.status).toBe('submitted');
    v = await t.app.transitionTicket.execute(kds, kitchen.id, { action: 'start' });
    expect(v.status).toBe('in_preparation');
    v = await t.app.transitionTicket.execute(kds, kitchen.id, { action: 'pause' });
    v = await t.app.transitionTicket.execute(kds, kitchen.id, { action: 'resume' });
    v = await t.app.transitionTicket.execute(kds, kitchen.id, { action: 'ready' });
    expect(v.status).toBe('partially_ready');

    const pastryKds = await t.as(f.authUsers.pastryKds);
    v = await t.app.transitionTicket.execute(pastryKds, pastry.id, { action: 'ready' });
    expect(v.status).toBe('ready');

    // Recall: kitchen found a problem, order is no longer fully ready.
    v = await t.app.transitionTicket.execute(kds, kitchen.id, { action: 'recall' });
    expect(v.status).toBe('partially_ready');
    expect(v.items.find((i) => i.stationId === f.stations.kitchen)!.status).toBe('in_preparation');

    const events = await db.query(
      'select action from production_ticket_events where ticket_id = $1 order by id',
      [kitchen.id],
    );
    expect(events.map((e) => e.action)).toEqual([
      'created',
      'accept',
      'start',
      'pause',
      'resume',
      'ready',
      'recall',
    ]);
  });

  it('invalid transitions and stale versions are refused', async () => {
    const order = await twoStationOrder();
    const kds = await t.as(f.authUsers.kitchenKds);
    const ticket = order.tickets.find((tk) => tk.stationId === f.stations.kitchen)!;
    await expect(t.app.transitionTicket.execute(kds, ticket.id, { action: 'resume' })).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await t.app.transitionTicket.execute(kds, ticket.id, {
      action: 'start',
      expectedVersion: ticket.version,
    });
    await expect(
      t.app.transitionTicket.execute(kds, ticket.id, { action: 'ready', expectedVersion: ticket.version }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('a station screen cannot act on another station, and cannot take payments', async () => {
    const order = await twoStationOrder();
    const kitchenKds = await t.as(f.authUsers.kitchenKds);
    const pastryTicket = order.tickets.find((tk) => tk.stationId === f.stations.pastry)!;
    await expect(
      t.app.transitionTicket.execute(kitchenKds, pastryTicket.id, { action: 'ready' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(t.app.getStationBoard.execute(kitchenKds, f.stations.pastry)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      t.app.recordPayment.execute(kitchenKds, order.id, { paymentId: uuid(), method: 'cash', tendered: 100 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a customer display is read-only', async () => {
    const order = await twoStationOrder();
    const display = await t.as(f.authUsers.display);
    await expect(
      t.app.transitionTicket.execute(display, order.tickets[0]!.id, { action: 'ready' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(t.app.getOrder.execute(display, order.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('items that need no preparation are ready immediately on an auto-ready station', async () => {
    await db.query('update stations set auto_ready = true where id = $1', [f.stations.drinks]);
    const cashier = await t.as(f.authUsers.cashier);
    const order = await t.app.submitOrder.execute(cashier, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(f.products.coke, 2)],
      send: { submissionId: uuid() },
    });
    expect(order.status).toBe('ready');
    expect(order.tickets[0]!.status).toBe('ready');
    expect(order.tickets[0]!.printJobs).toHaveLength(1); // still printed for the bar to hand out
    await db.query('update stations set auto_ready = false where id = $1', [f.stations.drinks]);
  });
});
