import type { Sql } from '@rp/infrastructure';
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
 * TEST 7 — Restaurant A can neither read nor modify Restaurant B, through the
 * use cases AND directly in SQL as the API's database role (so a bug in
 * application code still cannot cross tenants).
 */
describe('Tenant isolation', () => {
  let db: TestDatabase;
  let a: RestaurantFixture;
  let b: RestaurantFixture;
  let t: TestApp;
  let bOrderId: string;
  let bTicketId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    a = await seedRestaurant(db, { slug: 'restaurant-a' });
    b = await seedRestaurant(db, { slug: 'restaurant-b' });
    t = createTestApp(db);
    const bCashier = await t.as(b.authUsers.cashier);
    const order = await t.app.submitOrder.execute(bCashier, {
      orderId: uuid(),
      branchId: b.branchId,
      areaId: b.areas.takeaway,
      items: [line(b.products.jollof, 1)],
      send: { submissionId: uuid() },
    });
    bOrderId = order.id;
    bTicketId = order.tickets[0]!.id;
  });
  afterAll(() => db.close());

  /** Runs SQL exactly as the API does for tenant A: app_api role + tenant context. */
  async function asTenant<T>(restaurantId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
    return db.transaction(async (sql) => {
      await sql.query(`select set_config('app.restaurant_id', $1, true)`, [restaurantId]);
      await sql.query('set local role app_api');
      return fn(sql);
    });
  }

  describe('through the application', () => {
    it('A cannot read B orders, tickets, boards or print queues', async () => {
      const aManager = await t.as(a.authUsers.manager);
      await expect(t.app.getOrder.execute(aManager, bOrderId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(t.app.getStationBoard.execute(aManager, b.stations.kitchen)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(t.app.listActiveOrders.execute(aManager, b.branchId)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(t.app.getPrintQueue.execute(aManager, b.branchId)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('A cannot create an order in B, even by sending B ids', async () => {
      const aManager = await t.as(a.authUsers.manager);
      await expect(
        t.app.submitOrder.execute(aManager, {
          orderId: uuid(),
          branchId: b.branchId,
          areaId: b.areas.takeaway,
          items: [line(b.products.jollof, 1)],
          send: { submissionId: uuid() },
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // Own branch, but B's product id: not visible, so rejected.
      await expect(
        t.app.submitOrder.execute(aManager, {
          orderId: uuid(),
          branchId: a.branchId,
          areaId: a.areas.takeaway,
          items: [line(b.products.jollof, 1)],
          send: { submissionId: uuid() },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('A cannot operate B tickets, pay B orders or claim B print jobs', async () => {
      const aManager = await t.as(a.authUsers.manager);
      await expect(
        t.app.transitionTicket.execute(aManager, bTicketId, { action: 'ready' }),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        t.app.recordPayment.execute(aManager, bOrderId, { paymentId: uuid(), method: 'cash', tendered: 100 }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const aAgent = await t.as(a.authUsers.agent);
      const claimed = await t.app.claimPrintJobs.execute(aAgent, { limit: 20 });
      expect(claimed.every((j) => j.orderId !== bOrderId)).toBe(true);
    });
  });

  describe('directly in SQL as the API role (defence in depth)', () => {
    it('B rows are invisible to A', async () => {
      const counts = await asTenant(a.restaurantId, (sql) =>
        sql.query<{ orders: number; tickets: number; jobs: number; products: number; restaurants: number }>(
          `select (select count(*)::int from orders where restaurant_id = $1) as orders,
                  (select count(*)::int from production_tickets where restaurant_id = $1) as tickets,
                  (select count(*)::int from print_jobs where restaurant_id = $1) as jobs,
                  (select count(*)::int from products where restaurant_id = $1) as products,
                  (select count(*)::int from restaurants where id = $1) as restaurants`,
          [b.restaurantId],
        ),
      );
      expect(counts[0]).toEqual({ orders: 0, tickets: 0, jobs: 0, products: 0, restaurants: 0 });
    });

    it('A cannot update or delete B rows', async () => {
      const updated = await asTenant(a.restaurantId, (sql) =>
        sql.query(`update orders set notes = 'hacked' where id = $1 returning id`, [bOrderId]),
      );
      expect(updated).toHaveLength(0);
      const deleted = await asTenant(a.restaurantId, (sql) =>
        sql.query('delete from production_ticket_items where ticket_id = $1 returning ticket_id', [
          bTicketId,
        ]),
      );
      expect(deleted).toHaveLength(0);
      const [row] = await db.query<{ notes: string | null }>('select notes from orders where id = $1', [
        bOrderId,
      ]);
      expect(row!.notes).toBeNull();
    });

    it('A cannot create a production ticket for B (tenant column)', async () => {
      await expect(
        asTenant(a.restaurantId, (sql) =>
          sql.query(
            `insert into production_tickets (id, restaurant_id, branch_id, order_id, submission_id, station_id, order_number)
             select gen_random_uuid(), $1, $2, $3, s.id, $4, 1 from (select $5::uuid as id) s`,
            [b.restaurantId, b.branchId, bOrderId, b.stations.kitchen, uuid()],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' }); // row-level security violation
    });

    it('A cannot attach its own ticket to B order (tenant-scoped foreign keys)', async () => {
      const aCashier = await t.as(a.authUsers.cashier);
      const aOrder = await t.app.submitOrder.execute(aCashier, {
        orderId: uuid(),
        branchId: a.branchId,
        areaId: a.areas.takeaway,
        items: [line(a.products.coke, 1)],
        send: { submissionId: uuid() },
      });
      const aSubmission = aOrder.tickets[0]!.submissionId;
      await expect(
        asTenant(a.restaurantId, (sql) =>
          sql.query(
            `insert into production_tickets (id, restaurant_id, branch_id, order_id, submission_id, station_id, order_number)
             values (gen_random_uuid(), $1, $2, $3, $4, $5, 1)`,
            [a.restaurantId, a.branchId, bOrderId, aSubmission, a.stations.kitchen],
          ),
        ),
      ).rejects.toMatchObject({ code: '23503' }); // foreign key: (restaurant_id, order_id) must exist together
    });

    it('with no tenant context the API role sees nothing (fails closed)', async () => {
      const rows = await db.transaction(async (sql) => {
        await sql.query('set local role app_api');
        return sql.query('select id from orders');
      });
      expect(rows).toHaveLength(0);
    });

    it('audit logs are append-only for the API role', async () => {
      await expect(
        asTenant(a.restaurantId, (sql) =>
          sql.query('delete from audit_logs where restaurant_id = $1', [a.restaurantId]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('browser roles', () => {
    it('anon and authenticated have no privileges on any public table', async () => {
      const grants = await db.query<{ grantee: string; table_name: string }>(
        `select grantee, table_name from information_schema.role_table_grants
         where table_schema = 'public' and grantee in ('anon', 'authenticated')`,
      );
      expect(grants).toEqual([]);
    });

    it('realtime topic access is limited to members of that branch', async () => {
      const check = (sub: string, topic: string) =>
        db.transaction(async (sql) => {
          await sql.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub]);
          const [r] = await sql.query<{ ok: boolean }>('select app.can_join_branch_topic($1) as ok', [topic]);
          return r!.ok;
        });
      expect(await check(a.authUsers.cashier, `branch:${a.branchId}:orders`)).toBe(true);
      expect(await check(a.authUsers.agent, `branch:${a.branchId}:print`)).toBe(true);
      expect(await check(a.authUsers.cashier, `branch:${b.branchId}:orders`)).toBe(false);
      expect(await check(a.authUsers.agent, `branch:${b.branchId}:print`)).toBe(false);
      expect(await check(uuid(), `branch:${a.branchId}:orders`)).toBe(false);
    });
  });
});
