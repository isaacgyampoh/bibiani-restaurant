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

describe('Manual payments (V1: cash, MoMo, card; split = several records)', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'payments' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());

  // 150.00 order: 10 meat pies at 15.00
  async function order150() {
    const cashier = await t.as(f.authUsers.cashier, f.devices.pos);
    const o = await t.app.submitOrder.execute(cashier, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(f.products.meatPie, 10)],
      send: { submissionId: uuid() },
    });
    expect(o.grandTotal).toBe(15000);
    return { cashier, order: o };
  }

  it('cash 100 + MoMo 50 = paid; records method, amount, cashier and device', async () => {
    const { cashier, order } = await order150();
    await t.app.recordPayment.execute(cashier, order.id, {
      paymentId: uuid(),
      method: 'cash',
      amount: 10000,
    });
    const view = await t.app.recordPayment.execute(cashier, order.id, {
      paymentId: uuid(),
      method: 'momo',
      amount: 5000,
      reference: 'MTN-12345',
    });
    expect(view.paymentStatus).toBe('paid');
    expect(view.balanceDue).toBe(0);
    const rows = await db.query<{
      method: string;
      amount: string;
      recorded_by_staff_id: string;
      device_id: string;
      branch_id: string;
    }>(
      'select method, amount::text, recorded_by_staff_id, device_id, branch_id from payments where order_id = $1 order by created_at',
      [order.id],
    );
    expect(rows.map((r) => [r.method, r.amount])).toEqual([
      ['cash', '10000'],
      ['momo', '5000'],
    ]);
    expect(
      rows.every(
        (r) => r.recorded_by_staff_id && r.device_id === f.devices.pos && r.branch_id === f.branchId,
      ),
    ).toBe(true);
  });

  it('cash 50 + MoMo 50 leaves 50 remaining: partially paid', async () => {
    const { cashier, order } = await order150();
    await t.app.recordPayment.execute(cashier, order.id, { paymentId: uuid(), method: 'cash', amount: 5000 });
    const view = await t.app.recordPayment.execute(cashier, order.id, {
      paymentId: uuid(),
      method: 'momo',
      amount: 5000,
    });
    expect(view.paymentStatus).toBe('partially_paid');
    expect(view.balanceDue).toBe(5000);
  });

  it('cash tendered above the balance gives change; non-cash above the balance is refused', async () => {
    const { cashier, order } = await order150();
    const view = await t.app.recordPayment.execute(cashier, order.id, {
      paymentId: uuid(),
      method: 'cash',
      tendered: 20000,
    });
    expect(view.payments[0]).toMatchObject({ amount: 15000, tenderedAmount: 20000, changeAmount: 5000 });

    const second = await order150();
    await expect(
      t.app.recordPayment.execute(second.cashier, second.order.id, {
        paymentId: uuid(),
        method: 'card',
        amount: 20000,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_EXCEEDS_BALANCE' });
    await expect(
      t.app.recordPayment.execute(second.cashier, second.order.id, {
        paymentId: uuid(),
        method: 'momo',
        amount: 15000,
        tendered: 20000,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('a fully paid order refuses further payments', async () => {
    const { cashier, order } = await order150();
    await t.app.recordPayment.execute(cashier, order.id, {
      paymentId: uuid(),
      method: 'card',
      amount: 15000,
    });
    await expect(
      t.app.recordPayment.execute(cashier, order.id, { paymentId: uuid(), method: 'cash', amount: 100 }),
    ).rejects.toMatchObject({ code: 'ORDER_ALREADY_PAID' });
  });

  it('void needs permission, keeps the record, is audited and reopens the balance', async () => {
    const { cashier, order } = await order150();
    const paymentId = uuid();
    await t.app.recordPayment.execute(cashier, order.id, { paymentId, method: 'momo', amount: 15000 });
    await expect(
      t.app.voidPayment.execute(cashier, paymentId, { reason: 'wrong method' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const manager = await t.as(f.authUsers.manager);
    const view = await t.app.voidPayment.execute(manager, paymentId, {
      reason: 'Recorded as MoMo, was card',
    });
    expect(view.paymentStatus).toBe('unpaid');
    expect(view.payments[0]!.status).toBe('voided');
    const [audit] = await db.query<{ action: string; reason: string; before_data: { amount: number } }>(
      `select action, reason, before_data from audit_logs where entity_id = $1 and action = 'payment.void'`,
      [paymentId],
    );
    expect(audit).toMatchObject({ action: 'payment.void', reason: 'Recorded as MoMo, was card' });
    expect(audit!.before_data.amount).toBe(15000);
  });

  it('refunds are new records, capped at the original, and keep a completed order completed', async () => {
    const { cashier, order } = await order150();
    const paymentId = uuid();
    await t.app.recordPayment.execute(cashier, order.id, { paymentId, method: 'cash', amount: 15000 });
    const manager = await t.as(f.authUsers.manager);
    await t.app.transitionTicket.execute(manager, order.tickets[0]!.id, { action: 'ready' });
    let view = await t.app.fulfilOrder.execute(cashier, order.id, {});
    expect(view.status).toBe('completed');

    view = await t.app.refundPayment.execute(manager, paymentId, {
      refundId: uuid(),
      amount: 3000,
      reason: '2 pies burnt',
    });
    expect(view.paymentStatus).toBe('partially_refunded');
    expect(view.status).toBe('completed');
    await expect(
      t.app.refundPayment.execute(manager, paymentId, {
        refundId: uuid(),
        amount: 13000,
        reason: 'too much',
      }),
    ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_PAYMENT' });
  });

  it('an area configured "pay before production" refuses to send until paid', async () => {
    await db.query('update operational_areas set require_payment_before_production = true where id = $1', [
      f.areas.takeaway,
    ]);
    const cashier = await t.as(f.authUsers.cashier);
    const orderId = uuid();
    const base = {
      orderId,
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(f.products.coke, 2)],
    };
    await expect(
      t.app.submitOrder.execute(cashier, { ...base, send: { submissionId: uuid() } }),
    ).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED_BEFORE_PRODUCTION' });

    const draft = await t.app.submitOrder.execute(cashier, base);
    expect(draft.status).toBe('draft');
    await t.app.recordPayment.execute(cashier, orderId, {
      paymentId: uuid(),
      method: 'cash',
      tendered: 5000,
    });
    const sent = await t.app.sendOrderToKitchen.execute(cashier, orderId, { submissionId: uuid() });
    expect(sent.status).toBe('submitted');
    expect(sent.paymentStatus).toBe('paid');
    await db.query('update operational_areas set require_payment_before_production = false where id = $1', [
      f.areas.takeaway,
    ]);
  });
});
