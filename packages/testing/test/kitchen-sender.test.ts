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
 * The kitchen always knows who sent an order: the sender's name and role are captured when the
 * order is sent (a snapshot), shown on the kitchen screen, the supervisor board and the order,
 * and printed on the ticket. Renames, role changes and deactivation later do not rewrite it.
 */
describe('Kitchen sender identity', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'sender' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());

  const staffOf = async (authUserId: string) =>
    (await db.query<{ id: string }>('select id from staff where user_id = $1', [authUserId]))[0]!.id;

  async function sendAs(authUserId: string, submissionId = uuid()) {
    const ctx = await t.as(authUserId, f.devices.pos);
    return t.app.submitOrder.execute(ctx, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      customerName: 'Walk-in',
      items: [line(f.products.jollof, 1)],
      send: { submissionId },
    });
  }

  const ticketText = async (orderId: string) => {
    const [job] = await db.query<{ document: { blocks: { text?: string }[] } }>(
      `select document from print_jobs where order_id = $1 and kind = 'kitchen_ticket' limit 1`,
      [orderId],
    );
    return job!.document.blocks.map((b) => b.text ?? '');
  };

  it.each([
    ['waiter', 'Esi Waiter', 'Waiter'],
    ['cashier', 'Kofi Cashier', 'Cashier'],
    ['manager', 'Ama Owner', 'Owner'],
  ] as const)(
    'a %s who sends an order is on the ticket, the order and the kitchen screen',
    async (who, name, role) => {
      const order = await sendAs(f.authUsers[who]);
      expect(order.tickets[0]!.sentBy).toEqual({ name, role });
      expect(await ticketText(order.id)).toContain(`SENT BY: ${name.toUpperCase()} - ${role.toUpperCase()}`);

      const kds = await t.as(f.authUsers.kitchenKds);
      const board = await t.app.getStationBoard.execute(kds, f.stations.kitchen);
      const mine = board.tickets.find((x) => x.orderId === order.id)!;
      expect(mine.sentBy).toEqual({ name, role });
      expect(mine.sentAt).not.toBeNull();

      const expo = await t.app.getExpoBoard.execute(await t.as(f.authUsers.manager), f.branchId);
      expect(expo.orders.find((o) => o.id === order.id)!.stations[0]!.sentBy).toEqual({ name, role });
    },
  );

  it('survives a rename, a role change and deactivation of the sender', async () => {
    const order = await sendAs(f.authUsers.waiter);
    const staffId = await staffOf(f.authUsers.waiter);
    await db.query(`update staff set display_name = 'Esi Renamed' where id = $1`, [staffId]);
    await db.query(
      `update staff_roles set role_id = (select id from roles where restaurant_id = $2 and name = 'Cashier') where staff_id = $1`,
      [staffId, f.restaurantId],
    );
    await db.query('update staff set is_active = false where id = $1', [staffId]);

    const again = await t.app.getOrder.execute(await t.as(f.authUsers.manager), order.id);
    expect(again.tickets[0]!.sentBy).toEqual({ name: 'Esi Waiter', role: 'Waiter' });
    expect(await ticketText(order.id)).toContain('SENT BY: ESI WAITER - WAITER');

    await db.query(`update staff set display_name = 'Esi Waiter', is_active = true where id = $1`, [staffId]);
    await db.query(
      `update staff_roles set role_id = (select id from roles where restaurant_id = $2 and name = 'Waiter') where staff_id = $1`,
      [staffId, f.restaurantId],
    );
  });

  it('a repeated send (same submission) keeps the original sender, even from another sign-in', async () => {
    const submissionId = uuid();
    const ctx = await t.as(f.authUsers.waiter, f.devices.pos);
    const cmd = {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      customerName: 'Retry',
      items: [line(f.products.coke, 1)],
      send: { submissionId },
    };
    const first = await t.app.submitOrder.execute(ctx, cmd);
    // The same request again from a fresh sign-in (e.g. after the device reconnected).
    const replay = await t.app.submitOrder.execute(await t.as(f.authUsers.waiter, f.devices.pos), cmd);
    expect(replay.tickets).toHaveLength(first.tickets.length);
    expect(replay.tickets[0]!.sentBy).toEqual({ name: 'Esi Waiter', role: 'Waiter' });
    const [{ n }] = (await db.query<{ n: number }>(
      'select count(*)::int as n from order_submissions where id = $1',
      [submissionId],
    )) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('the kitchen ticket carries no customer telephone number', async () => {
    const ctx = await t.as(f.authUsers.waiter, f.devices.pos);
    const order = await t.app.submitOrder.execute(ctx, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      customerName: 'Private Person',
      customerPhone: '024 555 0101',
      items: [line(f.products.jollof, 1)],
      send: { submissionId: uuid() },
    });
    const text = (await ticketText(order.id)).join('\n');
    expect(text).not.toMatch(/555|0101|\+233/);
  });
});
