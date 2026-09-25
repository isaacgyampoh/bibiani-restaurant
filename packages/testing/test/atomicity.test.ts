import type { SubmitOrderCommand } from '@rp/contracts';
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

describe('TEST 6 — atomic order submission', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'atomic' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());

  const leftovers = async (orderId: string) => {
    const [r] = await db.query<Record<string, number>>(
      `select (select count(*)::int from orders where id = $1) as orders,
              (select count(*)::int from order_items where order_id = $1) as items,
              (select count(*)::int from order_submissions where order_id = $1) as submissions,
              (select count(*)::int from production_tickets where order_id = $1) as tickets,
              (select count(*)::int from print_jobs where order_id = $1) as jobs,
              (select count(*)::int from order_events where order_id = $1) as events`,
      [orderId],
    );
    return r;
  };
  const cmd = (): SubmitOrderCommand => ({
    orderId: uuid(),
    branchId: f.branchId,
    areaId: f.areas.hall,
    tableId: f.tables['2']!,
    items: [line(f.products.jollof, 1), line(f.products.chicken, 1)],
    send: { submissionId: uuid() },
  });

  it('a database failure while writing print jobs rolls back the order, items, tickets and table state', async () => {
    // A genuine Postgres error (division by zero) raised inside the same transaction,
    // at the last write of the submission: after order, items and tickets were inserted.
    const faulty = createTestApp(db, {
      decorate: (repos, sql) => ({
        ...repos,
        printJobs: { ...repos.printJobs, insert: async () => void (await sql.query('select 1/0')) },
      }),
    });
    const waiter = await faulty.as(f.authUsers.waiter);
    const c = cmd();
    await expect(faulty.app.submitOrder.execute(waiter, c)).rejects.toThrow();

    expect(await leftovers(c.orderId)).toEqual({
      orders: 0,
      items: 0,
      submissions: 0,
      tickets: 0,
      jobs: 0,
      events: 0,
    });
    const [table] = await db.query<{ status: string }>('select status from dining_tables where id = $1', [
      f.tables['2'],
    ]);
    expect(table!.status).toBe('available');

    // The same request succeeds once the fault is gone: nothing half-written blocks it.
    const ok = await t.app.submitOrder.execute(await t.as(f.authUsers.waiter), c);
    expect(ok.tickets).toHaveLength(2);
    expect(await leftovers(c.orderId)).toMatchObject({
      orders: 1,
      items: 2,
      submissions: 1,
      tickets: 2,
      jobs: 2,
    });
  });

  it('an invalid product anywhere in the order creates nothing', async () => {
    const cashier = await t.as(f.authUsers.cashier);
    const c: SubmitOrderCommand = {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(f.products.jollof, 1), line(uuid(), 1)],
      send: { submissionId: uuid() },
    };
    await expect(t.app.submitOrder.execute(cashier, c)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await leftovers(c.orderId)).toEqual({
      orders: 0,
      items: 0,
      submissions: 0,
      tickets: 0,
      jobs: 0,
      events: 0,
    });
  });

  it('a sold-out product is rejected and nothing is created', async () => {
    await db.query(
      `insert into branch_products (restaurant_id, branch_id, product_id, is_available) values ($1, $2, $3, false)`,
      [f.restaurantId, f.branchId, f.products.sandwich],
    );
    const cashier = await t.as(f.authUsers.cashier);
    const c: SubmitOrderCommand = {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(f.products.coke, 1), line(f.products.sandwich, 1)],
      send: { submissionId: uuid() },
    };
    await expect(t.app.submitOrder.execute(cashier, c)).rejects.toMatchObject({
      code: 'PRODUCT_UNAVAILABLE',
    });
    expect((await leftovers(c.orderId))!.orders).toBe(0);
  });

  it('when no station can receive an item the whole send is refused (no silent loss)', async () => {
    const other = await seedRestaurant(db, { slug: 'no-outputs' });
    await db.query(
      `update devices set is_active = false where restaurant_id = $1 and kind in ('printer', 'kds')`,
      [other.restaurantId],
    );
    const cashier = await t.as(other.authUsers.cashier);
    const c: SubmitOrderCommand = {
      orderId: uuid(),
      branchId: other.branchId,
      areaId: other.areas.takeaway,
      items: [line(other.products.coke, 1)],
      send: { submissionId: uuid() },
    };
    await expect(t.app.submitOrder.execute(cashier, c)).rejects.toMatchObject({ code: 'NO_ROUTE' });
    expect((await leftovers(c.orderId))!.orders).toBe(0);
  });

  it('two different orders cannot both claim the same table', async () => {
    const [a, b] = [cmd(), cmd()].map((c) => ({ ...c, tableId: f.tables['12']! }));
    const waiter = await t.as(f.authUsers.waiter);
    const results = await Promise.allSettled([
      t.app.submitOrder.execute(waiter, a!),
      t.app.submitOrder.execute(waiter, b!),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'TABLE_UNAVAILABLE' });
  });
});
