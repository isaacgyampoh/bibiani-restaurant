import { canonicalPhone, displayPhone } from '@rp/domain';
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
 * Customer database: the telephone number is required, validated and stored in one canonical
 * form, so the same number typed differently is the same customer. Orders taken with a number
 * link to the customer automatically. Details are private (customer.view), tills can only look
 * up and attach, and another restaurant never sees them.
 */
describe('Customers', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let other: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'customers' });
    other = await seedRestaurant(db, { slug: 'customers-other' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());

  const manager = () => t.as(f.authUsers.manager);

  it('normalises Ghanaian numbers however they are typed', () => {
    for (const typed of [
      '024 123 4567',
      '0241234567',
      '+233 24 123 4567',
      '233241234567',
      '(024) 123-4567',
      '241234567',
    ])
      expect(canonicalPhone(typed)).toBe('+233241234567');
    expect(canonicalPhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(canonicalPhone('12345')).toBeNull();
    expect(canonicalPhone('0241')).toBeNull();
    expect(displayPhone('+233241234567')).toBe('024 123 4567');
  });

  it('a customer cannot be created without a valid telephone number', async () => {
    const m = await manager();
    await expect(
      t.app.createCustomer.execute(m, { customerId: uuid(), fullName: 'No Phone', phone: '' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      t.app.createCustomer.execute(m, { customerId: uuid(), fullName: 'Bad Phone', phone: '12-34' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('creates a customer, and the same number in another format is "already exists"', async () => {
    const m = await manager();
    const kofi = await t.app.createCustomer.execute(m, {
      customerId: uuid(),
      fullName: 'Kofi Mensah',
      phone: '024 123 4567',
      email: 'kofi@example.com',
    });
    expect(kofi.phone).toBe('+233241234567');
    expect(kofi.phoneDisplay).toBe('024 123 4567');
    await expect(
      t.app.createCustomer.execute(m, { customerId: uuid(), fullName: 'Kofi Again', phone: '+233241234567' }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_EXISTS', details: { customerId: kofi.id } });
    // Retrying the same create is not a duplicate.
    const again = await t.app.createCustomer.execute(m, {
      customerId: kofi.id,
      fullName: 'Kofi Mensah',
      phone: '0241234567',
    });
    expect(again.id).toBe(kofi.id);
    const [{ n }] = (await db.query<{ n: number }>(
      `select count(*)::int as n from customers where phone = '+233241234567'`,
    )) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('an order taken with a telephone number links to the customer (found or created); visits and spend follow', async () => {
    const waiter = await t.as(f.authUsers.waiter, f.devices.pos);
    const cashier = await t.as(f.authUsers.cashier, f.devices.pos);
    const place = async (phone: string, name: string | null) => {
      const order = await t.app.submitOrder.execute(waiter, {
        orderId: uuid(),
        branchId: f.branchId,
        areaId: f.areas.takeaway,
        customerName: name,
        customerPhone: phone,
        items: [line(f.products.jollof, 1)],
        send: { submissionId: uuid() },
      });
      await t.app.recordPayment.execute(cashier, order.id, {
        paymentId: uuid(),
        method: 'cash',
        tendered: 5000,
      });
      return order;
    };
    const first = await place('0241234567', 'Kofi');
    expect(first.customerPhone).toBe('+233241234567');
    await place('+233 24 123 4567', null);
    const ama = await place('020 777 8888', 'Ama Boateng');

    const m = await manager();
    const list = await t.app.listCustomers.execute(m, { search: '024 123' });
    expect(list.customers).toHaveLength(1);
    expect(list.customers[0]).toMatchObject({ fullName: 'Kofi Mensah', orders: 2, totalSpend: 9000 });
    const byName = await t.app.listCustomers.execute(m, { search: 'boateng' });
    expect(byName.customers.map((c) => c.fullName)).toEqual(['Ama Boateng']);

    const detail = await t.app.getCustomer.execute(m, byName.customers[0]!.id);
    expect(detail.recentOrders).toHaveLength(1);
    expect(detail.recentOrders[0]).toMatchObject({
      orderNumber: ama.orderNumber,
      channel: 'takeaway',
      total: 4500,
    });
    expect(detail.recentOrders[0]!.methods).toEqual(['cash']);
    expect(detail.recentOrders[0]!.items).toContain('Jollof Rice');
  });

  it('an invalid number on an order is refused with a clear message', async () => {
    const waiter = await t.as(f.authUsers.waiter, f.devices.pos);
    await expect(
      t.app.submitOrder.execute(waiter, {
        orderId: uuid(),
        branchId: f.branchId,
        areaId: f.areas.takeaway,
        customerName: 'X',
        customerPhone: '123',
        items: [line(f.products.coke, 1)],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('tills look up customers: an exact number shows it; a name search masks numbers; the list is closed to them', async () => {
    const waiter = await t.as(f.authUsers.waiter, f.devices.pos);
    const exact = await t.app.lookupCustomer.execute(waiter, '0241234567');
    expect(exact.matches[0]).toMatchObject({
      fullName: 'Kofi Mensah',
      phoneDisplay: '024 123 4567',
      exact: true,
    });
    const byName = await t.app.lookupCustomer.execute(waiter, 'Ama');
    expect(byName.matches[0]!.phoneDisplay).toBe('020 *** 8888');
    await expect(t.app.listCustomers.execute(waiter, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const someone = (await t.app.listCustomers.execute(await manager(), {})).customers[0]!;
    await expect(t.app.getCustomer.execute(waiter, someone.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      t.app.updateCustomer.execute(waiter, someone.id, { fullName: 'X', phone: '0241234567', version: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('attaches a customer to an open order at checkout', async () => {
    const waiter = await t.as(f.authUsers.waiter, f.devices.pos);
    const order = await t.app.submitOrder.execute(waiter, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      customerName: 'Later',
      items: [line(f.products.coke, 1)],
    });
    const updated = await t.app.setOrderCustomer.execute(waiter, order.id, {
      customerName: 'Yaw Darko',
      customerPhone: '054 222 3333',
    });
    expect(updated.customerPhone).toBe('+233542223333');
    expect(updated.customerName).toBe('Yaw Darko');
    const [{ customer_id }] = (await db.query<{ customer_id: string }>(
      'select customer_id from orders where id = $1',
      [order.id],
    )) as [{ customer_id: string }];
    expect(customer_id).not.toBeNull();
  });

  it('edits are versioned and audited without storing the private values; a number already in use is refused', async () => {
    const m = await manager();
    const kofi = (await t.app.listCustomers.execute(m, { search: 'Kofi' })).customers[0]!;
    const detail = await t.app.getCustomer.execute(m, kofi.id);
    await expect(
      t.app.updateCustomer.execute(m, kofi.id, {
        fullName: 'Kofi M.',
        phone: '020 777 8888',
        version: detail.version,
      }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_EXISTS' });
    const saved = await t.app.updateCustomer.execute(m, kofi.id, {
      fullName: 'Kofi Mensah',
      phone: '0241234567',
      notes: 'Likes extra pepper',
      version: detail.version,
    });
    expect(saved.notes).toBe('Likes extra pepper');
    await expect(
      t.app.updateCustomer.execute(m, kofi.id, {
        fullName: 'Stale',
        phone: '0241234567',
        version: detail.version,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const [audit] = await db.query<{ after_data: unknown }>(
      `select after_data from audit_logs where action = 'customer.update' and entity_id = $1 order by id desc limit 1`,
      [kofi.id],
    );
    expect(JSON.stringify(audit!.after_data)).not.toContain('pepper');
  });

  it('merges a duplicate: history moves to the kept customer, nothing is deleted, the merge is audited', async () => {
    const m = await manager();
    const keep = (await t.app.listCustomers.execute(m, { search: 'Kofi' })).customers[0]!;
    const dup = await t.app.createCustomer.execute(m, {
      customerId: uuid(),
      fullName: 'K. Mensah',
      phone: '0249990000',
    });
    const waiter = await t.as(f.authUsers.waiter, f.devices.pos);
    await t.app.submitOrder.execute(waiter, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      customerName: 'K. Mensah',
      customerPhone: '0249990000',
      items: [line(f.products.coke, 1)],
      send: { submissionId: uuid() },
    });
    const merged = await t.app.mergeCustomer.execute(m, dup.id, {
      intoCustomerId: keep.id,
      reason: 'Same person, second phone',
    });
    expect(merged.orders).toBe(keep.orders + 1);
    expect(merged.mergedFrom.map((x) => x.id)).toEqual([dup.id]);
    const list = await t.app.listCustomers.execute(m, { search: '0249990000' });
    expect(list.customers).toHaveLength(0);
    const [{ n }] = (await db.query<{ n: number }>(
      `select count(*)::int as n from audit_logs where action = 'customer.merge' and entity_id = $1`,
      [keep.id],
    )) as [{ n: number }];
    expect(n).toBe(1);
    await expect(
      t.app.mergeCustomer.execute(m, dup.id, { intoCustomerId: keep.id, reason: 'again' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('another restaurant sees none of these customers (application and database)', async () => {
    const theirs = await t.as(other.authUsers.manager);
    expect((await t.app.listCustomers.execute(theirs, {})).total).toBe(0);
    const ours = (await t.app.listCustomers.execute(await manager(), {})).customers[0]!;
    await expect(t.app.getCustomer.execute(theirs, ours.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const rows = await db.transaction(async (sql) => {
      await sql.query(`select set_config('app.restaurant_id', $1, true)`, [other.restaurantId]);
      await sql.query('set local role app_api');
      return sql.query('select id from customers');
    });
    expect(rows).toHaveLength(0);
  });
});

describe('Customer report', () => {
  it('counts customers, new and returning customers, from linked orders only', async () => {
    const db = await createTestDatabase();
    const f = await seedRestaurant(db, { slug: 'customer-report' });
    const t = createTestApp(db);
    const waiter = await t.as(f.authUsers.waiter, f.devices.pos);
    const order = (phone: string, name: string) =>
      t.app.submitOrder.execute(waiter, {
        orderId: uuid(),
        branchId: f.branchId,
        areaId: f.areas.takeaway,
        customerName: name,
        customerPhone: phone,
        items: [line(f.products.coke, 1)],
        send: { submissionId: uuid() },
      });
    await order('0241112222', 'Returning Rita');
    await db.query(`update orders set business_day = '2026-09-20'`);
    await order('0241112222', 'Returning Rita');
    await order('0203334444', 'New Nana');
    const v = await t.app.getReport.execute(await t.as(f.authUsers.manager), 'customers', {
      branchId: f.branchId,
      preset: 'custom',
      from: '2026-09-25',
      to: '2026-09-25',
    });
    const m = Object.fromEntries(v.summary[0]!.metrics.map((x) => [x.label, x.value]));
    expect(m).toMatchObject({ 'Customers who ordered': 2, 'Returning customers': 1, 'Their orders': 2 });
    const rita = v.tables[0]!.rows.find((r) => r.name === 'Returning Rita')!;
    expect(rita).toMatchObject({
      phone: '024 111 2222',
      orders: 1,
      lifetime_orders: 2,
      first_visit_text: '2026-09-20',
    });
    await expect(
      t.app.getReport.execute(await t.as(f.authUsers.waiter), 'customers', {
        branchId: f.branchId,
        preset: 'today',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db.close();
  });
});
