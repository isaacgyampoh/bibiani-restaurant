import type { Database, Sql } from '@rp/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestDatabase,
  HOSTED,
  type RestaurantFixture,
  seedRestaurant,
  type TestDatabase,
} from '../src';
import { line, uuid } from './helpers';

/**
 * Round trips per operation. Every query is a network round trip to Postgres,
 * so this is the main driver of latency when the API is not next to the
 * database. Budgets fail the build if a change adds N+1 queries.
 */
function counting(db: Database) {
  const stats = { queries: 0, texts: [] as string[] };
  const wrap = (sql: Sql): Sql => ({
    query: (text, params) => {
      stats.queries++;
      stats.texts.push(text.replace(/\s+/g, ' ').slice(0, 70));
      return sql.query(text, params);
    },
  });
  const counted: Database = {
    ...db,
    query: wrap(db).query,
    transaction: (fn) => db.transaction((tx) => fn(wrap(tx))),
  };
  return { counted, stats };
}

describe.skipIf(HOSTED)('Query budget per operation', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'budget' });
  });
  afterAll(() => db.close());

  it('reports and bounds round trips for the hot paths', async () => {
    const { counted, stats } = counting(db);
    const t = createTestApp(counted);
    const measure = async (name: string, fn: () => Promise<unknown>) => {
      stats.queries = 0;
      stats.texts = [];
      await fn();
      return { name, queries: stats.queries, texts: [...stats.texts] };
    };
    const waiter = await t.as(f.authUsers.waiter);
    const orderId = uuid();
    const results = [
      await measure('submit order (4 stations, 4 lines)', () =>
        t.app.submitOrder.execute(waiter, {
          orderId,
          branchId: f.branchId,
          areaId: f.areas.hall,
          tableId: f.tables['12']!,
          items: [
            line(f.products.jollof, 2),
            line(f.products.chicken, 2),
            line(f.products.meatPie, 2),
            line(f.products.coke, 2),
          ],
          send: { submissionId: uuid() },
        }),
      ),
    ];
    const order = await t.app.getOrder.execute(waiter, orderId);
    const manager = await t.as(f.authUsers.manager);
    results.push(
      await measure('KDS ticket ready', () =>
        t.app.transitionTicket.execute(manager, order.tickets[0]!.id, { action: 'ready' }),
      ),
    );
    results.push(
      await measure('record payment', () =>
        t.app.recordPayment.execute(manager, orderId, { paymentId: uuid(), method: 'cash', amount: 1000 }),
      ),
    );
    results.push(
      await measure('station board (KDS load)', () =>
        t.app.getStationBoard.execute(manager, f.stations.kitchen),
      ),
    );
    results.push(await measure('menu (POS load)', () => t.app.getMenu.execute(waiter, f.branchId)));
    const agent = await t.as(f.authUsers.agent);
    results.push(
      await measure('print agent claim', () => t.app.claimPrintJobs.execute(agent, { limit: 10 })),
    );
    console.log(`\nQUERY BUDGET\n${results.map((r) => `  ${r.name}: ${r.queries} round trips`).join('\n')}`);
    console.log(results[0]!.texts.map((x, i) => `    ${i + 1}. ${x}`).join('\n'));
    // Current counts, with a little headroom. Raise deliberately, never by accident.
    const budget: Record<string, number> = {
      'submit order (4 stations, 4 lines)': 46,
      'KDS ticket ready': 17,
      'record payment': 14,
      'station board (KDS load)': 6,
      'menu (POS load)': 8,
      'print agent claim': 9,
    };
    for (const r of results) expect(r.queries, r.name).toBeLessThanOrEqual(budget[r.name]!);
  });
});
