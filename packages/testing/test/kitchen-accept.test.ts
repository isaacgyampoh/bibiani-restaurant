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
 * Kitchen workflow NEW -> ACCEPT -> START -> READY -> DONE (restaurant request, 2026-10-01).
 * ACCEPT ("the kitchen has received this order") is recorded separately from START ("cooking has
 * begun"), with who/which screen and the server's time; a voided ticket stays visible as VOIDED.
 */
describe('kitchen ACCEPT step', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'kitchen-accept' });
    t = createTestApp(db);
  });
  afterAll(async () => {
    await db.close();
  });

  /** An order with one jollof (Main Kitchen) sent by the waiter. */
  async function jollofOrder() {
    const waiter = await t.as(f.authUsers.waiter, f.devices.pos);
    const order = await t.app.submitOrder.execute(waiter, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      customerName: 'Ama',
      items: [line(f.products.jollof, 1)],
      send: { submissionId: uuid() },
    });
    const ticket = order.tickets.find((tk) => tk.stationId === f.stations.kitchen)!;
    return { order, ticket };
  }
  const row = async (ticketId: string) =>
    (
      (await db.query<{
        status: string;
        created_at: Date;
        accepted_at: Date | null;
        started_at: Date | null;
        ready_at: Date | null;
        completed_at: Date | null;
        accepted_by_staff_id: string | null;
        accepted_by_device_id: string | null;
        accepted_by_name: string | null;
        accepted_by_role: string | null;
      }>('select * from production_tickets where id = $1', [ticketId])) as [never]
    )[0] as {
      status: string;
      created_at: Date;
      accepted_at: Date | null;
      started_at: Date | null;
      ready_at: Date | null;
      completed_at: Date | null;
      accepted_by_staff_id: string | null;
      accepted_by_device_id: string | null;
      accepted_by_name: string | null;
      accepted_by_role: string | null;
    };

  it('a new ticket starts NEW; ACCEPT records who and when and does NOT start cooking', async () => {
    const { ticket } = await jollofOrder();
    expect(ticket.status).toBe('new');
    const kds = await t.as(f.authUsers.kitchenKds);
    const view = await t.app.transitionTicket.execute(kds, ticket.id, { action: 'accept' });
    expect(view.tickets.find((tk) => tk.id === ticket.id)!.status).toBe('accepted');
    expect(view.status).toBe('submitted'); // not "in preparation"
    const r = await row(ticket.id);
    expect(r.status).toBe('accepted');
    expect(r.accepted_at).not.toBeNull();
    expect(r.started_at).toBeNull();
    // A paired kitchen screen is a device, not a person: the screen is what is recorded.
    expect(r.accepted_by_device_id).toBe(f.kds.kitchen);
    expect(r.accepted_by_staff_id).toBeNull();

    const board = await t.app.getStationBoard.execute(kds, f.stations.kitchen);
    const shown = board.tickets.find((tk) => tk.id === ticket.id)!;
    expect(shown.acceptedAt).not.toBeNull();
    expect(shown.acceptedOn).toBe('KITCHEN-KDS-01');
  });

  it('a signed-in staff member who accepts is recorded by name and role, at that moment', async () => {
    const { ticket } = await jollofOrder();
    const manager = await t.as(f.authUsers.manager);
    await t.app.transitionTicket.execute(manager, ticket.id, { action: 'accept' });
    const r = await row(ticket.id);
    expect(r.accepted_by_staff_id).not.toBeNull();
    expect(r.accepted_by_name).toBeTruthy();
    expect(r.accepted_by_role).toBe('Owner');
  });

  it('START, READY and DONE each have their own server time; the full history is kept', async () => {
    const { ticket } = await jollofOrder();
    const kds = await t.as(f.authUsers.kitchenKds);
    for (const action of ['accept', 'start', 'ready', 'complete'] as const)
      await t.app.transitionTicket.execute(kds, ticket.id, { action });
    const r = await row(ticket.id);
    expect(r.status).toBe('completed');
    const times = [r.created_at, r.accepted_at, r.started_at, r.ready_at, r.completed_at];
    expect(times.every((x) => x !== null)).toBe(true);
    for (let i = 1; i < times.length; i++)
      expect(new Date(times[i]!).getTime()).toBeGreaterThanOrEqual(new Date(times[i - 1]!).getTime());
    const events = await db.query<{ action: string }>(
      'select action from production_ticket_events where ticket_id = $1 order by id',
      [ticket.id],
    );
    expect(events.map((e) => e.action)).toEqual(['created', 'accept', 'start', 'ready', 'complete']);
  });

  it('who may accept: not a waiter, not another station’s screen', async () => {
    const { ticket } = await jollofOrder();
    await expect(
      t.app.transitionTicket.execute(await t.as(f.authUsers.waiter), ticket.id, { action: 'accept' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      t.app.transitionTicket.execute(await t.as(f.authUsers.pastryKds), ticket.id, { action: 'accept' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      t.app.transitionTicket.execute(await t.as(f.authUsers.waiter), ticket.id, { action: 'start' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('supervisor override: READY straight from NEW for a station without a screen; no accept time invented', async () => {
    const { ticket } = await jollofOrder();
    // A kitchen screen cannot use the override.
    await expect(
      t.app.transitionTicket.execute(await t.as(f.authUsers.kitchenKds), ticket.id, {
        action: 'ready',
        expedite: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION', message: 'Press ACCEPT first' });
    await t.app.transitionTicket.execute(await t.as(f.authUsers.manager), ticket.id, {
      action: 'ready',
      expedite: true,
    });
    const r = await row(ticket.id);
    expect(r.status).toBe('ready');
    expect(r.accepted_at).toBeNull();
    expect(r.started_at).toBeNull();
  });

  for (const stage of ['new', 'accepted', 'in_preparation'] as const)
    it(`void while ${stage}: the ticket becomes VOIDED on the screen (not gone), with who and why; a repeat is harmless`, async () => {
      const { order, ticket } = await jollofOrder();
      const kds = await t.as(f.authUsers.kitchenKds);
      if (stage !== 'new') await t.app.transitionTicket.execute(kds, ticket.id, { action: 'accept' });
      if (stage === 'in_preparation')
        await t.app.transitionTicket.execute(kds, ticket.id, { action: 'start' });
      const manager = await t.as(f.authUsers.manager);
      const cmd = { requestId: uuid(), itemIds: [order.items[0]!.id], reason: 'Customer changed order' };
      await t.app.voidItems.execute(manager, order.id, cmd);
      await t.app.voidItems.execute(manager, order.id, cmd); // double tap / retry

      const board = await t.app.getStationBoard.execute(kds, f.stations.kitchen);
      const shown = board.tickets.find((tk) => tk.id === ticket.id)!;
      expect(shown.status).toBe('cancelled');
      expect(shown.cancelledAt).not.toBeNull();
      expect(shown.items[0]).toMatchObject({ status: 'voided', voidReason: 'Customer changed order' });
      expect(shown.items[0]!.voidedBy).toBeTruthy();
      // The kitchen cannot carry on with it.
      await expect(t.app.transitionTicket.execute(kds, ticket.id, { action: 'ready' })).rejects.toBeTruthy();
      // History kept: the original ticket and its events stay; one void slip per printer.
      const events = await db.query<{ action: string }>(
        'select action from production_ticket_events where ticket_id = $1 order by id',
        [ticket.id],
      );
      expect(events.map((e) => e.action).at(-1)).toBe('voided');
      const [{ n }] = (await db.query<{ n: number }>(
        `select count(*)::int as n from print_jobs where order_id = $1 and kind = 'void_slip'`,
        [order.id],
      )) as [{ n: number }];
      expect(n).toBe(1);
    });
});
