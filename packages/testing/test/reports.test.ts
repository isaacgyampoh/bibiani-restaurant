import type { ReportQuery, ReportView } from '@rp/contracts';
import { ROLE_TEMPLATES } from '@rp/domain';
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
 * Reports reconcile with the transactions they come from: tax with the tax recorded on the order
 * lines, sales with the order totals, payments with the payment records. One trading day with:
 *   A  dine-in, Esi (waiter): 2 x Jollof 90.00, cash
 *   B  takeaway, Esi: Chicken 60.00 + Coke 10.00 (+5% levy added) = 70.50, split MoMo 30 + cash 40.50
 *   C  takeaway, Kofi (cashier): Meat Pie 15.00, card
 *   D  takeaway, Esi: never sent, cancelled — not a sale
 *   E  takeaway, Esi: Jollof + Meat Pie, pie voided; unpaid
 *   F  takeaway, Kofi at 02:00 the next morning (before the 04:00 cutoff: same business day), cash
 */
describe('Reports', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;
  let inventoryManager: string;
  const DAY = '2026-09-25';
  const orders: Record<string, string> = {};
  /** Coke's total with the added levy (the levy is on the price net of the included tax). */
  let coke = 0;

  const q = (extra: Partial<ReportQuery> = {}): ReportQuery => ({
    branchId: f.branchId,
    preset: 'custom',
    from: DAY,
    to: DAY,
    ...extra,
  });
  const report = async (
    kind: Parameters<TestApp['app']['getReport']['execute']>[1],
    extra: Partial<ReportQuery> = {},
  ) => t.app.getReport.execute(await t.as(f.authUsers.manager), kind, q(extra));
  const WIDE = { from: '2026-01-01', to: '2026-12-31' };
  const metric = (v: ReportView, label: string) =>
    v.summary.flatMap((g) => g.metrics).find((m) => m.label === label)?.value;
  const rows = (v: ReportView, id: string) => v.tables.find((x) => x.id === id)!.rows;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'reports' });
    t = createTestApp(db);

    // An exclusive (added on top) 5% levy on Coke, besides the inclusive 15% on everything.
    const [{ id: levy }] = (await db.query<{ id: string }>(
      `insert into tax_rates (restaurant_id, name, rate_bp, is_inclusive) values ($1, 'Levy', 500, false) returning id`,
      [f.restaurantId],
    )) as [{ id: string }];
    await db.query(`insert into product_taxes (restaurant_id, product_id, tax_rate_id) values ($1, $2, $3)`, [
      f.restaurantId,
      f.products.coke,
      levy,
    ]);

    const waiter = await t.as(f.authUsers.waiter, f.devices.pos);
    const cashier = await t.as(f.authUsers.cashier, f.devices.pos);
    const manager = await t.as(f.authUsers.manager);
    const submit = (
      ctx: typeof waiter,
      area: 'hall' | 'takeaway',
      items: ReturnType<typeof line>[],
      send = true,
    ) =>
      t.app.submitOrder.execute(ctx, {
        orderId: uuid(),
        branchId: f.branchId,
        areaId: f.areas[area],
        tableId: area === 'hall' ? f.tables['1'] : null,
        customerName: area === 'takeaway' ? 'Guest' : null,
        items,
        ...(send ? { send: { submissionId: uuid() } } : {}),
      });
    const pay = (id: string, method: 'cash' | 'momo' | 'card', amount?: number) =>
      t.app.recordPayment.execute(cashier, id, {
        paymentId: uuid(),
        method,
        ...(amount ? { amount } : { tendered: 20000 }),
      });

    const a = await submit(waiter, 'hall', [line(f.products.jollof, 2)]);
    await pay(a.id, 'cash');
    const b = await submit(waiter, 'takeaway', [line(f.products.chicken, 1), line(f.products.coke, 1)]);
    coke = b.grandTotal - 6000;
    expect(coke).toBeGreaterThan(1000);
    await pay(b.id, 'momo', 3000);
    await pay(b.id, 'cash', b.grandTotal - 3000);
    const c = await submit(cashier, 'takeaway', [line(f.products.meatPie, 1)]);
    await pay(c.id, 'card', 1500);
    const d = await submit(waiter, 'takeaway', [line(f.products.coke, 1)], false);
    await t.app.cancelOrder.execute(manager, d.id, { reason: 'Customer left' });
    const e = await submit(waiter, 'takeaway', [line(f.products.jollof, 1), line(f.products.meatPie, 1)]);
    const pie = e.items.find((i) => i.productId === f.products.meatPie)!;
    await t.app.voidItems.execute(manager, e.id, {
      requestId: uuid(),
      itemIds: [pie.id],
      reason: 'Dropped it',
    });
    t.clock.advance(14 * 3600); // 2026-09-26 02:00 in Accra: still the 25th's trading day
    const late = await submit(cashier, 'takeaway', [line(f.products.coke, 1)]);
    await pay(late.id, 'cash');
    Object.assign(orders, { a: a.id, b: b.id, c: c.id, d: d.id, e: e.id, f: late.id });

    // Stock ledger: 10 kg rice received, 1 kg wasted, 0.5 kg adjusted away.
    const { id: rice } = await t.app.saveInventoryItem.execute(manager, {
      branchId: f.branchId,
      name: 'Rice',
      unit: 'kg',
      unitCost: 2000,
      minQuantity: 2,
      isActive: true,
    });
    const move = (kind: 'receive' | 'waste' | 'adjust', quantity: number, extra: object = {}) =>
      t.app.recordStockMovement.execute(manager, {
        movementId: uuid(),
        itemId: rice,
        kind,
        quantity,
        ...extra,
      });
    await move('receive', 10, { unitCost: 2000, reference: 'INV-001 Makola Rice' });
    await move('waste', 1, { reason: 'Spoilt' });
    await move('adjust', -0.5, { reason: 'Spilled' });

    // An inventory manager (reports and stock, no customer access).
    const [{ id: role }] = (await db.query<{ id: string }>(
      `insert into roles (restaurant_id, name, is_system) values ($1, 'Inventory Manager', true) returning id`,
      [f.restaurantId],
    )) as [{ id: string }];
    for (const p of ROLE_TEMPLATES['Inventory Manager']!)
      await db.query(
        'insert into role_permissions (restaurant_id, role_id, permission_code) values ($1, $2, $3)',
        [f.restaurantId, role, p],
      );
    inventoryManager = uuid();
    await db.query('insert into auth.users (id) values ($1)', [inventoryManager]);
    const [{ id: staff }] = (await db.query<{ id: string }>(
      `insert into staff (restaurant_id, user_id, display_name) values ($1, $2, 'Yaw Stock') returning id`,
      [f.restaurantId, inventoryManager],
    )) as [{ id: string }];
    await db.query(
      'insert into staff_roles (restaurant_id, staff_id, role_id, branch_id) values ($1, $2, $3, $4)',
      [f.restaurantId, staff, role, f.branchId],
    );
  });
  afterAll(() => db.close());

  /** What the orders and payments tables say, independently of the report code. */
  const truth = async () => {
    const [o] = await db.query<{ tax: number; grand: number; n: number }>(
      `select coalesce(sum(tax_total), 0)::int as tax, coalesce(sum(grand_total), 0)::int as grand, count(*)::int as n
         from orders where branch_id = $1 and business_day = $2 and status not in ('cancelled', 'voided', 'draft')`,
      [f.branchId, DAY],
    );
    const [p] = await db.query<{ net: number }>(
      `select coalesce(sum(case when direction = 'charge' then amount else -amount end), 0)::int as net
         from payments where branch_id = $1 and status = 'recorded'`,
      [f.branchId],
    );
    return { ...o!, received: p!.net };
  };

  it('tax report reconciles with the tax recorded on the orders, per configured rate', async () => {
    const v = await report('tax');
    const real = await truth();
    expect(metric(v, 'Total tax')).toBe(real.tax);
    const breakdown = rows(v, 'tax_breakdown');
    expect(breakdown.map((r) => [r.name, r.rate_bp, r.treatment])).toEqual([
      ['Standard tax', 1500, 'Included in price'],
      ['Levy', 500, 'Added to price'],
    ]);
    expect(breakdown.find((r) => r.name === 'Levy')!.tax).toBe(2 * (coke - 1000));
    expect(v.tables[0]!.totals!.tax).toBe(real.tax);
    expect(v.period.label).toBe('25 September 2026');
    expect(v.notes.join(' ')).toMatch(/not an official tax return/);
    // Net sales + tax added on top = what the orders total.
    expect(Number(metric(v, 'Net sales')) + 2 * (coke - 1000)).toBe(real.grand);
    expect(metric(v, 'Voided items (not in sales)')).toBe(1500);
  });

  it('end of day: sales, payments, service types, staff, terminals, voids and bills all reconcile', async () => {
    const v = await report('end_of_day');
    const real = await truth();
    expect(metric(v, 'Orders')).toBe(real.n);
    expect(metric(v, 'Total sales (incl. tax)')).toBe(real.grand);
    expect(metric(v, 'Net received')).toBe(real.received);
    expect(metric(v, 'Cash')).toBe(9000 + (6000 + coke - 3000) + coke);
    expect(metric(v, 'MoMo')).toBe(3000);
    expect(metric(v, 'Card')).toBe(1500);
    expect(metric(v, 'Orders paid in split payments')).toBe(1);
    expect(metric(v, 'Dine-in orders')).toBe(1);
    expect(metric(v, 'Dine-in sales')).toBe(9000);
    expect(metric(v, 'Takeaway orders')).toBe(4);
    expect(metric(v, 'Items voided')).toBe(1);
    expect(metric(v, 'Orders cancelled or voided')).toBe(1);
    expect(metric(v, 'Unpaid on open orders')).toBe(4500);
    expect(rows(v, 'terminals').map((r) => r.terminal)).toEqual(['POS-01']);
  });

  it('item sales: quantities of sold lines only (not pending, cancelled or voided), sortable', async () => {
    const v = await report('items', { sort: 'quantity' });
    const byItem = Object.fromEntries(rows(v, 'items').map((r) => [r.item, r.quantity]));
    expect(byItem).toEqual({ 'Jollof Rice': 3, Coke: 2, 'Grilled Chicken': 1, 'Meat Pie': 1 });
    expect(rows(v, 'items')[0]!.item).toBe('Jollof Rice');
    const jollof = rows(v, 'items').find((r) => r.item === 'Jollof Rice')!;
    expect(jollof.average).toBe(4500);
    expect(v.tables[0]!.totals!.net).toBe(metric(v, 'Net sales'));
  });

  it('payment methods: split parts counted once each, order not double counted', async () => {
    const v = await report('payment_methods');
    expect(rows(v, 'methods').map((r) => [r.method_label, r.payments, r.net, r.orders])).toEqual([
      ['Cash', 3, 9000 + (6000 + coke - 3000) + coke, 3],
      ['MoMo', 1, 3000, 1],
      ['Card', 1, 1500, 1],
    ]);
    expect(metric(v, 'Orders paid in parts')).toBe(1);
    expect(metric(v, 'Net received')).toBe((await truth()).received);
  });

  it('sales by staff keeps order staff, kitchen sender and cashier separate', async () => {
    const v = await report('sales_by_staff');
    const esi = rows(v, 'staff').find((r) => r.staff === 'Esi Waiter')!;
    const kofi = rows(v, 'staff').find((r) => r.staff === 'Kofi Cashier')!;
    expect(esi).toMatchObject({ role: 'Waiter', orders: 3, orders_sent: 3, payments: 0, collected: 0 });
    expect(esi.sales).toBe(9000 + 6000 + coke + 4500);
    expect(kofi).toMatchObject({ role: 'Cashier', orders: 2, orders_sent: 2, payments: 5 });
    expect(kofi.collected).toBe((await truth()).received);
    expect(v.notes.join(' ')).toMatch(/not a ranking/);

    const o = await report('orders');
    const a = rows(o, 'orders').find((r) => r.id === orders.a)!;
    expect(a).toMatchObject({
      order_staff: 'Esi Waiter',
      sent_by: 'Esi Waiter',
      cashier: 'Kofi Cashier',
      channel_label: 'Dine-in',
    });

    // Audit and stock-ledger timestamps come from the database clock, not the test clock.
    const act = await report('staff_activity', WIDE);
    const manager = rows(act, 'activity').find((r) => r.staff === 'Ama Owner')!;
    expect(manager).toMatchObject({ voids: 1, cancellations: 1 });
  });

  it('service types and terminals', async () => {
    const s = await report('service_types');
    expect(rows(s, 'service').map((r) => [r.channel_label, r.orders, r.total])).toEqual([
      ['Dine-in', 1, 9000],
      ['Takeaway', 4, 6000 + coke + 1500 + 4500 + coke],
    ]);
    const term = await report('terminals');
    expect(rows(term, 'terminals')[0]).toMatchObject({
      terminal: 'POS-01',
      payments: 5,
      cash: 9000 + (6000 + coke - 3000) + coke,
      momo: 3000,
      card: 1500,
    });
  });

  it('filters change the figures: service type, payment method, staff', async () => {
    const take = await report('end_of_day', { channel: 'takeaway' });
    expect(metric(take, 'Orders')).toBe(4);
    const momo = await report('items', { method: 'momo' });
    expect(
      rows(momo, 'items')
        .map((r) => r.item)
        .sort(),
    ).toEqual(['Coke', 'Grilled Chicken']);
    expect(momo.filters).toEqual([{ label: 'Payment method', value: 'MoMo' }]);
    const esiId = (
      await db.query<{ id: string }>(`select id from staff where display_name = 'Esi Waiter'`)
    )[0]!.id;
    const mine = await report('orders', { staffId: esiId });
    expect(rows(mine, 'orders').every((r) => r.order_staff === 'Esi Waiter')).toBe(true);
    expect(mine.filters).toEqual([{ label: 'Staff', value: 'Esi Waiter' }]);
    const cancelled = await report('orders', { orderStatus: 'cancelled' });
    expect(rows(cancelled, 'orders').map((r) => r.id)).toEqual([orders.d]);
  });

  it('periods use the restaurant business day: 02:00 belongs to yesterday; an empty period is empty', async () => {
    const today = await t.app.getReport.execute(await t.as(f.authUsers.manager), 'end_of_day', {
      branchId: f.branchId,
      preset: 'today',
    });
    expect(today.period).toMatchObject({ from: DAY, to: DAY });
    const empty = await t.app.getReport.execute(await t.as(f.authUsers.manager), 'items', {
      branchId: f.branchId,
      preset: 'yesterday',
    });
    expect(empty.period.from).toBe('2026-09-24');
    expect(rows(empty, 'items')).toEqual([]);
    expect(empty.tables[0]!.totals).toBeNull();
    expect(metric(empty, 'Net sales')).toBe(0);
    await expect(
      t.app.getReport.execute(await t.as(f.authUsers.manager), 'items', {
        branchId: f.branchId,
        preset: 'custom',
        from: '2026-09-30',
        to: '2026-09-01',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('inventory reports come from the stock ledger', async () => {
    const val = await report('inventory_valuation');
    expect(rows(val, 'valuation')[0]).toMatchObject({
      item: 'Rice',
      quantity: 8.5,
      value: 17000,
      stock_status: 'OK',
    });
    const mv = await report('stock_movements', WIDE);
    expect(rows(mv, 'stock_movements').map((r) => [r.kind, r.quantity_before, r.quantity_after])).toEqual([
      ['adjust', 9, 8.5],
      ['waste', 10, 9],
      ['receive', 0, 10],
    ]);
    const del = await report('deliveries', WIDE);
    expect(rows(del, 'deliveries')[0]).toMatchObject({
      reference: 'INV-001 Makola Rice',
      value: 20000,
      staff: 'Ama Owner',
    });
    expect(metric(del, 'Total cost')).toBe(20000);
    const waste = await report('wastage', WIDE);
    expect(rows(waste, 'wastage')[0]).toMatchObject({ reason: 'Spoilt', value: 2000 });
    const adj = await report('adjustments', WIDE);
    expect(rows(adj, 'adjustments')[0]).toMatchObject({ reason: 'Spilled', quantity_delta: -0.5 });
    const filtered = await report('stock_movements', { ...WIDE, movementKind: 'waste' });
    expect(rows(filtered, 'stock_movements')).toHaveLength(1);
  });

  it('permissions: waiters see no reports; inventory managers see stock but not customers', async () => {
    await expect(
      t.app.getReport.execute(await t.as(f.authUsers.waiter), 'end_of_day', q()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const inv = await t.as(inventoryManager);
    expect((await t.app.getReport.execute(inv, 'inventory_valuation', q())).tables[0]!.rows).toHaveLength(1);
    await expect(t.app.getReport.execute(inv, 'customers', q())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      t.app.exportReport.execute(await t.as(f.authUsers.waiter), 'tax', 'pdf', q()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an export returns the same view as the screen and is audited with format, filters and device', async () => {
    const manager = await t.as(f.authUsers.manager, f.devices.pos);
    const screen = await t.app.getReport.execute(manager, 'items', q({ channel: 'takeaway' }));
    const exported = await t.app.exportReport.execute(manager, 'items', 'xlsx', q({ channel: 'takeaway' }));
    expect(exported.tables).toEqual(screen.tables);
    expect(exported.summary).toEqual(screen.summary);
    const [audit] = await db.query<{
      after_data: { format: string; filters: unknown[] };
      actor_device_id: string;
    }>(
      `select after_data, actor_device_id from audit_logs where action = 'report.export' order by id desc limit 1`,
    );
    expect(audit!.after_data.format).toBe('xlsx');
    expect(audit!.after_data.filters).toEqual([{ label: 'Service type', value: 'Takeaway' }]);
    expect(audit!.actor_device_id).toBe(f.devices.pos);
  });
});
