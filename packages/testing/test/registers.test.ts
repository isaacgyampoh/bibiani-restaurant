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
 * Cashier registers: open with a float, take payments, close with the counted cash. Expected
 * cash = float + cash taken − cash refunded; the variance is recorded as it is, never adjusted.
 */
describe('Cash registers', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'registers' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());

  const cashier = () => t.as(f.authUsers.cashier, f.devices.pos);

  async function paidOrder(
    method: 'cash' | 'momo' | 'card',
    area: 'takeaway' | 'dining' = 'takeaway',
    by = cashier,
  ) {
    const ctx = await by();
    const order = await t.app.submitOrder.execute(ctx, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas[area],
      tableId: area === 'dining' ? f.tables['12'] : null,
      customerName: 'Guest',
      items: [line(f.products.jollof, 2)], // 90.00
      send: { submissionId: uuid() },
    });
    return t.app.recordPayment.execute(ctx, order.id, {
      paymentId: uuid(),
      method,
      ...(method === 'cash' ? { tendered: 10000 } : { amount: 9000 }),
    });
  }

  let sessionId: string;

  it('the cashier opens a register on their terminal with an opening float', async () => {
    sessionId = uuid();
    const r = await t.app.openRegister.execute(await cashier(), {
      sessionId,
      branchId: f.branchId,
      openingCash: 50000,
    });
    expect(r).toMatchObject({
      status: 'open',
      cashierName: 'Kofi Cashier',
      terminalName: 'POS-01',
      deviceId: f.devices.pos,
      openingCash: 50000,
      expectedCash: 50000,
    });
    // The same open again is idempotent; a second register for the same cashier is refused.
    expect(
      (
        await t.app.openRegister.execute(await cashier(), {
          sessionId,
          branchId: f.branchId,
          openingCash: 50000,
        })
      ).id,
    ).toBe(sessionId);
    await expect(
      t.app.openRegister.execute(await cashier(), {
        sessionId: uuid(),
        branchId: f.branchId,
        openingCash: 0,
      }),
    ).rejects.toMatchObject({ code: 'REGISTER_OPEN' });
    // Nobody else can open a second register on the same terminal.
    await expect(
      t.app.openRegister.execute(await t.as(f.authUsers.manager, f.devices.pos), {
        sessionId: uuid(),
        branchId: f.branchId,
        openingCash: 0,
      }),
    ).rejects.toMatchObject({ code: 'REGISTER_OPEN' });
    // A waiter has no register.
    await expect(
      t.app.openRegister.execute(await t.as(f.authUsers.waiter, f.devices.pos), {
        sessionId: uuid(),
        branchId: f.branchId,
        openingCash: 0,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('payments the cashier takes are counted in the register; voided ones are not', async () => {
    await paidOrder('cash'); // 90.00 cash (100 tendered, 10 change)
    await paidOrder('cash', 'dining');
    await paidOrder('momo');
    const card = await paidOrder('card');
    // A payment by someone else does not go into this register.
    await paidOrder('cash', 'takeaway', () => t.as(f.authUsers.manager, null));
    // A mistaken card payment is voided.
    await t.app.voidPayment.execute(await t.as(f.authUsers.manager), card.payments[0]!.id, {
      reason: 'Wrong method',
    });
    // A cash refund of 20.00 on the first cash order comes out of the drawer.
    const [firstCash] = await db.query<{ id: string }>(
      `select id from payments where register_session_id = $1 and method = 'cash' order by created_at limit 1`,
      [sessionId],
    );
    // The manager refunds it at the cashier's till: it comes out of that till's drawer.
    await t.app.refundPayment.execute(await t.as(f.authUsers.manager, f.devices.pos), firstCash!.id, {
      refundId: uuid(),
      amount: 2000,
      reason: 'Cold food',
    });

    const r = await t.app.getCurrentRegister.execute(await cashier(), f.branchId);
    expect(r).toMatchObject({
      cashSales: 18000,
      cashRefunds: 2000,
      expectedCash: 50000 + 18000 - 2000,
      orders: { total: 3, dineIn: 1, takeaway: 2 },
    });
    expect(r!.byMethod.find((m) => m.method === 'momo')!.net).toBe(9000);
    expect(r!.byMethod.find((m) => m.method === 'card')!.net).toBe(0);
    expect(r!.totalNet).toBe(18000 - 2000 + 9000);
  });

  it('closing records counted cash, expected cash and the variance as they are, and is audited', async () => {
    const before = (await t.app.getCurrentRegister.execute(await cashier(), f.branchId))!;
    const closed = await t.app.closeRegister.execute(await cashier(), sessionId, {
      countedCash: 65000,
      version: before.version,
      note: 'Short by 10',
    });
    expect(closed).toMatchObject({
      status: 'closed',
      expectedCash: 66000,
      countedCash: 65000,
      variance: -1000,
    });
    expect(closed.closedByName).toBe('Kofi Cashier');
    const [audit] = await db.query<{ after_data: { variance: number; expectedCash: number } }>(
      `select after_data from audit_logs where action = 'register.close' and entity_id = $1`,
      [sessionId],
    );
    expect(audit!.after_data).toMatchObject({ variance: -1000, expectedCash: 66000 });
    expect(await t.app.getCurrentRegister.execute(await cashier(), f.branchId)).toBeNull();
  });

  it('a double close returns the same close; a different second close is refused', async () => {
    const r = await t.app.getRegister.execute(await cashier(), sessionId);
    const again = await t.app.closeRegister.execute(await cashier(), sessionId, {
      countedCash: 65000,
      version: r.version - 1,
    });
    expect(again.variance).toBe(-1000);
    await expect(
      t.app.closeRegister.execute(await cashier(), sessionId, { countedCash: 66000, version: r.version }),
    ).rejects.toMatchObject({ code: 'REGISTER_CLOSED' });
    const [{ n }] = (await db.query<{ n: number }>(
      `select count(*)::int as n from audit_logs where action = 'register.close' and entity_id = $1`,
      [sessionId],
    )) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('a closed register cannot be edited, even directly in the database', async () => {
    await expect(
      db.transaction(async (sql) => {
        await sql.query(`select set_config('app.restaurant_id', $1, true)`, [f.restaurantId]);
        await sql.query('set local role app_api');
        await sql.query('update register_sessions set counted_cash = 66000, variance = 0 where id = $1', [
          sessionId,
        ]);
      }),
    ).rejects.toThrow(/closed/);
  });

  it('only a manager can reopen, with a reason; the undone close is kept in the audit', async () => {
    await expect(
      t.app.reopenRegister.execute(await cashier(), sessionId, { reason: 'I miscounted' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const reopened = await t.app.reopenRegister.execute(await t.as(f.authUsers.manager), sessionId, {
      reason: 'Recount requested',
    });
    expect(reopened).toMatchObject({
      status: 'open',
      reopenCount: 1,
      reopenReason: 'Recount requested',
      variance: null,
    });
    const [audit] = await db.query<{ before_data: { countedCash: number; variance: number } }>(
      `select before_data from audit_logs where action = 'register.reopen' and entity_id = $1`,
      [sessionId],
    );
    expect(audit!.before_data).toMatchObject({ countedCash: 65000, variance: -1000 });
    const closed = await t.app.closeRegister.execute(await cashier(), sessionId, {
      countedCash: 66000,
      version: reopened.version,
    });
    expect(closed.variance).toBe(0);
  });

  it('the closing report has the cashier, terminal, cash, other methods, orders and sign-off lines', async () => {
    const report = await t.app.getRegisterClosingReport.execute(await cashier(), sessionId);
    expect(report.title).toBe('Cashier Register Closing');
    const metrics = Object.fromEntries(
      report.summary.flatMap((g) => g.metrics.map((m) => [m.label, m.value])),
    );
    expect(metrics).toMatchObject({
      Cashier: 'Kofi Cashier',
      Terminal: 'POS-01',
      'Opening cash': 50000,
      'Cash sales': 18000,
      'Expected cash': 66000,
      'Actual cash (counted)': 66000,
      Variance: 0,
      MoMo: 9000,
      Card: 0,
      Orders: 3,
      'Dine-in': 1,
      Takeaway: 2,
    });
    expect(report.signOff).toEqual(['Cashier signature', 'Manager signature']);
    // Another cashier cannot read it.
    const [{ id: other }] = (await db.query<{ id: string }>(
      `insert into staff (restaurant_id, user_id, display_name) values ($1, $2, 'Other Cashier') returning id`,
      [f.restaurantId, await newUser()],
    )) as [{ id: string }];
    await db.query(
      `insert into staff_roles (restaurant_id, staff_id, role_id, branch_id)
       select $1, $2, id, $3 from roles where restaurant_id = $1 and name = 'Cashier'`,
      [f.restaurantId, other, f.branchId],
    );
    const [{ user_id }] = (await db.query<{ user_id: string }>('select user_id from staff where id = $1', [
      other,
    ])) as [{ user_id: string }];
    await expect(
      t.app.getRegisterClosingReport.execute(await t.as(user_id), sessionId),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  async function newUser() {
    const id = uuid();
    await db.query('insert into auth.users (id) values ($1)', [id]);
    return id;
  }
});
