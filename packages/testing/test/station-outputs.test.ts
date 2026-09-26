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
 * A station's screen and printer are independent outputs: a station may have a screen,
 * a printer, both, or (temporarily) neither. Seed: every station has one KDS and one printer.
 */
describe('station outputs — screens and printers are independent', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'station-outputs' });
    t = createTestApp(db);
    // Pastry: printer only. Drinks: screen only. Grill: screen + printer (unchanged).
    await db.query(
      `delete from station_outputs so using devices d
        where d.id = so.device_id and so.station_id = $1 and d.kind = 'kds'`,
      [f.stations.pastry],
    );
    await db.query(
      `delete from station_outputs so using devices d
        where d.id = so.device_id and so.station_id = $1 and d.kind = 'printer'`,
      [f.stations.drinks],
    );
  });
  afterAll(() => db.close());

  const order = async (productId: string) =>
    t.app.submitOrder.execute(await t.as(f.authUsers.cashier), {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(productId, 1)],
      send: { submissionId: uuid() },
    });

  const jobsFor = (orderId: string) =>
    db.query<{ printer_id: string; kind: string }>(
      `select printer_id, kind from print_jobs where order_id = $1 and kind = 'kitchen_ticket'`,
      [orderId],
    );

  it('printer-only station: ticket is printed, and the supervisor can complete it without a screen', async () => {
    const o = await order(f.products.meatPie);
    const ticket = o.tickets.find((tk) => tk.stationId === f.stations.pastry);
    expect(ticket).toBeDefined();
    expect((await jobsFor(o.id)).map((j) => j.printer_id)).toEqual([f.printers.pastry]);

    const manager = await t.as(f.authUsers.manager);
    await t.app.markOrderReady.execute(manager, o.id);
    expect((await t.app.getOrder.execute(manager, o.id)).status).toBe('ready');
  });

  it('screen-only station: ticket reaches the screen and nothing is printed', async () => {
    const o = await order(f.products.coke);
    expect(o.tickets.map((tk) => tk.stationId)).toEqual([f.stations.drinks]);
    expect(await jobsFor(o.id)).toEqual([]);
    const board = await t.app.getStationBoard.execute(await t.as(f.authUsers.manager), f.stations.drinks);
    expect(board.tickets.some((tk) => tk.orderId === o.id)).toBe(true);
  });

  it('screen + printer station: both receive the ticket', async () => {
    const o = await order(f.products.chicken);
    expect(o.tickets.map((tk) => tk.stationId)).toEqual([f.stations.grill]);
    expect((await jobsFor(o.id)).map((j) => j.printer_id)).toEqual([f.printers.grill]);
    const board = await t.app.getStationBoard.execute(await t.as(f.authUsers.manager), f.stations.grill);
    expect(board.tickets.some((tk) => tk.orderId === o.id)).toBe(true);
  });

  it('a station whose outputs are all disabled is skipped: items fall through to the default station', async () => {
    await db.query(
      `update devices set is_active = false where id in (select device_id from station_outputs where station_id = $1)`,
      [f.stations.grill],
    );
    try {
      const o = await order(f.products.chicken);
      expect(o.tickets.map((tk) => tk.stationId)).toEqual([f.stations.kitchen]);
    } finally {
      await db.query(
        `update devices set is_active = true where id in (select device_id from station_outputs where station_id = $1)`,
        [f.stations.grill],
      );
    }
  });

  it('test print: queued for the agent once per request, audited; cashiers and disabled printers refused', async () => {
    const manager = await t.as(f.authUsers.manager);
    const requestId = uuid();
    const first = await t.app.sendTestPrint.execute(manager, f.printers.grill, { requestId });
    const again = await t.app.sendTestPrint.execute(manager, f.printers.grill, { requestId });
    expect(again.printJobId).toBe(first.printJobId);
    expect(
      await db.query(`select count(*)::int n from print_jobs where kind = 'test' and printer_id = $1`, [
        f.printers.grill,
      ]),
    ).toEqual([{ n: 1 }]);

    const claimed = (await t.app.claimPrintJobs.execute(await t.as(f.authUsers.agent), { limit: 50 })).find(
      (j) => j.id === first.printJobId,
    );
    expect(claimed?.document.blocks.some((b) => b.type === 'text' && b.text === 'TEST PRINT')).toBe(true);

    const [audit] = await db.query<{ n: number }>(
      `select count(*)::int n from audit_logs where action = 'printer.test_print' and entity_id = $1`,
      [f.printers.grill],
    );
    expect(audit!.n).toBe(1);

    await expect(
      t.app.sendTestPrint.execute(await t.as(f.authUsers.cashier), f.printers.grill, { requestId: uuid() }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await db.query('update devices set is_active = false where id = $1', [f.printers.drinks]);
    await expect(
      t.app.sendTestPrint.execute(manager, f.printers.drinks, { requestId: uuid() }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await db.query('update devices set is_active = true where id = $1', [f.printers.drinks]);
  });
});
