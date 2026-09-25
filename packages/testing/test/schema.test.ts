import {
  DEVICE_KINDS,
  ORDER_CHANNELS,
  ORDER_ITEM_STATUSES,
  ORDER_STATUSES,
  PAYMENT_DIRECTIONS,
  PAYMENT_METHODS,
  PAYMENT_POLICIES,
  PAYMENT_RECORD_STATUSES,
  PAYMENT_STATUSES,
  PERMISSIONS,
  PRINT_JOB_KINDS,
  PRINT_JOB_STATUSES,
  ROUTING_MATCHES,
  STATION_OUTPUT_ROLES,
  TABLE_STATUSES,
  TICKET_STATUSES,
} from '@rp/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestDatabase, HOSTED, seedRestaurant, type TestDatabase } from '../src';
import { line, uuid } from './helpers';

describe('Schema contract', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db.close());

  it('database enums match the domain definitions exactly', async () => {
    const rows = await db.query<{ name: string; values: string[] }>(
      `select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as values
       from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public' group by t.typname`,
    );
    const db_ = Object.fromEntries(rows.map((r) => [r.name, r.values]));
    expect(db_).toEqual({
      order_channel: [...ORDER_CHANNELS],
      order_status: [...ORDER_STATUSES],
      payment_status: [...PAYMENT_STATUSES],
      order_item_status: [...ORDER_ITEM_STATUSES],
      ticket_status: [...TICKET_STATUSES],
      print_job_kind: [...PRINT_JOB_KINDS],
      print_job_status: [...PRINT_JOB_STATUSES],
      printer_connection: ['network_escpos', 'usb_escpos'],
      payment_method: [...PAYMENT_METHODS],
      payment_direction: [...PAYMENT_DIRECTIONS],
      payment_record_status: [...PAYMENT_RECORD_STATUSES],
      device_kind: [...DEVICE_KINDS],
      device_status: ['unknown', 'online', 'offline'],
      station_output_role: [...STATION_OUTPUT_ROLES],
      routing_match: [...ROUTING_MATCHES],
      table_status: [...TABLE_STATUSES],
      payment_policy: [...PAYMENT_POLICIES],
    });
    const perms = await db.query<{ code: string }>('select code from permissions order by code');
    expect(perms.map((p) => p.code)).toEqual([...PERMISSIONS].sort());
  });

  it('every public table has RLS enabled and a tenant restaurant_id column (except the global catalogue)', async () => {
    const tables = await db.query<{ tablename: string; rowsecurity: boolean; has_tenant: boolean }>(
      `select t.tablename, t.rowsecurity,
              exists (select 1 from information_schema.columns c
                      where c.table_schema = 'public' and c.table_name = t.tablename and c.column_name = 'restaurant_id') as has_tenant
       from pg_tables t where t.schemaname = 'public' order by 1`,
    );
    expect(tables.filter((t) => !t.rowsecurity)).toEqual([]);
    expect(tables.filter((t) => !t.has_tenant).map((t) => t.tablename)).toEqual([
      'permissions',
      'restaurants',
    ]);
  });

  it('the unique index blocks a second active order on a table even if application checks were bypassed', async () => {
    const f = await seedRestaurant(db, { slug: 'backstop' });
    const t = createTestApp(db);
    const waiter = await t.as(f.authUsers.waiter);
    const first = await t.app.submitOrder.execute(waiter, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.hall,
      tableId: f.tables['1']!,
      items: [line(f.products.coke, 1)],
    });
    await expect(
      db.query(
        `insert into orders (id, restaurant_id, branch_id, area_id, channel, business_day, order_number, table_id, request_hash, status)
         values ($1, $2, $3, $4, 'dine_in', current_date, 999, $5, 'x', 'submitted')`,
        [uuid(), f.restaurantId, f.branchId, f.areas.hall, f.tables['1']],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    expect(first.status).toBe('draft');
  });

  it.skipIf(HOSTED)(
    'emits realtime change signals on private branch topics (ids and status only)',
    async () => {
      const f = await seedRestaurant(db, { slug: 'signals' });
      const t = createTestApp(db);
      await db.query('delete from realtime.captured_messages');
      const cashier = await t.as(f.authUsers.cashier);
      const order = await t.app.submitOrder.execute(cashier, {
        orderId: uuid(),
        branchId: f.branchId,
        areaId: f.areas.takeaway,
        items: [line(f.products.jollof, 1)],
        send: { submissionId: uuid() },
      });
      const msgs = await db.query<{
        topic: string;
        event: string;
        payload: Record<string, unknown>;
        private: boolean;
      }>('select topic, event, payload, private from realtime.captured_messages order by id');
      const topics = new Set(msgs.map((m) => m.topic));
      expect(topics).toContain(`branch:${f.branchId}:orders`);
      expect(topics).toContain(`branch:${f.branchId}:station:${f.stations.kitchen}`);
      expect(topics).toContain(`branch:${f.branchId}:print`);
      expect(msgs.every((m) => m.private)).toBe(true);
      const last = msgs.filter((m) => m.event === 'order_changed').at(-1)!;
      expect(last.payload).toMatchObject({ order_id: order.id, status: 'submitted', version: order.version });
      expect(JSON.stringify(msgs)).not.toContain('customer');
    },
  );
});
