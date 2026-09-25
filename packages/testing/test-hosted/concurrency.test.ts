import { randomUUID } from 'node:crypto';
import type { SubmitOrderCommand } from '@rp/contracts';
import {
  ACTIVE_ITEM,
  computeTotals,
  deriveOrderStatus,
  derivePaymentStatus,
  type OrderItem,
  summarizePayments,
} from '@rp/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestDatabase,
  HOSTED,
  type RestaurantFixture,
  seedRestaurant,
  type TestApp,
  type TestDatabase,
} from '../src';

/**
 * REAL concurrency: runs only against hosted Supabase DEV (TEST_TARGET=hosted).
 * Every request in a Promise.all runs in its own transaction on its own pooled
 * connection, so row locks, advisory locks and unique constraints actually race.
 */
const uuid = () => randomUUID();
const line = (productId: string, quantity = 1) => ({
  id: uuid(),
  productId,
  quantity,
  modifierIds: [],
  notes: null,
});

describe.skipIf(!HOSTED)('Concurrency on hosted Postgres (multiple connections)', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let other: RestaurantFixture;
  let t: TestApp;
  const results: { case: string; outcome: string }[] = [];

  beforeAll(async () => {
    db = await createTestDatabase({ maxConnections: 20 });
    [f, other] = await Promise.all([
      seedRestaurant(db, { slug: 'conc' }),
      seedRestaurant(db, { slug: 'conc-other' }),
    ]);
    t = createTestApp(db);
  });
  afterAll(async () => {
    console.log(`\nCONCURRENCY RESULTS\n${results.map((r) => `  ${r.case}: ${r.outcome}`).join('\n')}`);
    await db.close();
  });

  const count = async (sql: string, params: unknown[]) =>
    Number((await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params))[0]!.n);

  /** Recomputes everything derivable about an order from its rows and compares with what is stored. */
  async function assertConsistent(orderId: string) {
    const [o] = await db.query<Record<string, unknown>>('select * from orders where id = $1', [orderId]);
    const items = await db.query<Record<string, unknown>>(
      `select i.*, coalesce((select json_agg(json_build_object('isInclusive', x.is_inclusive, 'amount', x.amount)) from order_item_taxes x where x.order_item_id = i.id), '[]') as tax_lines
       from order_items i where order_id = $1`,
      [orderId],
    );
    const payments = await db.query<Record<string, unknown>>('select * from payments where order_id = $1', [
      orderId,
    ]);
    const domainItems = items.map((i) => ({
      status: i.status,
      lineTotal: Number(i.line_total),
      taxTotal: Number(i.tax_total),
      taxLines: (i.tax_lines as { isInclusive: boolean; amount: number }[]).map((x) => ({
        ...x,
        amount: Number(x.amount),
      })),
    })) as unknown as OrderItem[];
    const totals = computeTotals(domainItems);
    const paid = summarizePayments(
      payments.map((p) => ({
        id: String(p.id),
        direction: p.direction as 'charge',
        method: p.method as 'cash',
        amount: Number(p.amount),
        status: p.status as 'recorded',
        refundOfPaymentId: (p.refund_of_payment_id as string) ?? null,
      })),
    );
    const paymentStatus = derivePaymentStatus(totals.grandTotal, paid, domainItems.some(ACTIVE_ITEM));
    expect(Number(o!.grand_total)).toBe(totals.grandTotal);
    expect(Number(o!.paid_total)).toBe(paid.paidTotal);
    expect(o!.payment_status).toBe(paymentStatus);
    expect(o!.status).toBe(
      deriveOrderStatus(o!.status as 'draft', o!.channel as 'dine_in', domainItems, paymentStatus),
    );
    // Every sent item is on exactly one ticket; no station has two tickets for one submission.
    expect(
      await count(
        `order_items i where i.order_id = $1 and i.submission_id is not null and (select count(*) from production_ticket_items p where p.order_item_id = i.id) <> 1`,
        [orderId],
      ),
    ).toBe(0);
    expect(
      await count(
        `(select submission_id, station_id from production_tickets where order_id = $1 group by 1, 2 having count(*) > 1) d`,
        [orderId],
      ),
    ).toBe(0);
  }

  const takeaway = (
    fx: RestaurantFixture,
    items = [line(fx.products.jollof), line(fx.products.coke)],
  ): SubmitOrderCommand => ({
    orderId: uuid(),
    branchId: fx.branchId,
    areaId: fx.areas.takeaway,
    items,
    send: { submissionId: uuid() },
  });

  it('A — simultaneous different orders get unique, gap-free order numbers', async () => {
    const cashier = await t.as(f.authUsers.cashier);
    const orders = await Promise.all(
      Array.from({ length: 12 }, () => t.app.submitOrder.execute(cashier, takeaway(f))),
    );
    const numbers = orders.map((o) => o.orderNumber).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(12);
    expect(numbers.at(-1)! - numbers[0]!).toBe(11);
    for (const o of orders) await assertConsistent(o.id);
    results.push({
      case: 'A 12 parallel orders',
      outcome: `12 orders, numbers ${numbers[0]}..${numbers.at(-1)}, no duplicates, no gaps`,
    });
  });

  it('B — simultaneous retries of the same order create it exactly once', async () => {
    const cashier = await t.as(f.authUsers.cashier);
    const cmd = takeaway(f);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () => t.app.submitOrder.execute(cashier, cmd)),
    );
    const ok = outcomes.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(8);
    expect(await count('orders where id = $1', [cmd.orderId])).toBe(1);
    expect(await count('order_items where order_id = $1', [cmd.orderId])).toBe(2);
    expect(await count('order_submissions where order_id = $1', [cmd.orderId])).toBe(1);
    expect(await count('production_tickets where order_id = $1', [cmd.orderId])).toBe(2);
    expect(await count('print_jobs where order_id = $1', [cmd.orderId])).toBe(2);
    await assertConsistent(cmd.orderId);
    results.push({
      case: 'B 8 parallel identical submits',
      outcome: '8 identical responses; 1 order, 2 items, 1 submission, 2 tickets, 2 print jobs',
    });
  });

  it('C — two simultaneous send-to-kitchen operations produce one set of tickets', async () => {
    const cashier = await t.as(f.authUsers.cashier);
    const draft = await t.app.submitOrder.execute(cashier, { ...takeaway(f), send: null });
    const outcomes = await Promise.allSettled([
      t.app.sendOrderToKitchen.execute(cashier, draft.id, { submissionId: uuid() }),
      t.app.sendOrderToKitchen.execute(cashier, draft.id, { submissionId: uuid() }),
    ]);
    const rejected = outcomes.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: 'NOTHING_TO_SEND' });
    expect(await count('order_submissions where order_id = $1', [draft.id])).toBe(1);
    expect(await count('production_tickets where order_id = $1', [draft.id])).toBe(2);
    await assertConsistent(draft.id);
    results.push({
      case: 'C 2 parallel sends (different ids)',
      outcome: '1 sent, 1 NOTHING_TO_SEND; 1 submission, 2 tickets',
    });
  });

  it('D — same payment id twice at once records one payment; two different full payments never double-charge', async () => {
    const cashier = await t.as(f.authUsers.cashier);
    const order = await t.app.submitOrder.execute(cashier, takeaway(f));
    const same = { paymentId: uuid(), method: 'momo' as const, amount: order.grandTotal, reference: 'MTN-1' };
    const sameResults = await Promise.allSettled([
      t.app.recordPayment.execute(cashier, order.id, same),
      t.app.recordPayment.execute(cashier, order.id, same),
    ]);
    expect(sameResults.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await count('payments where order_id = $1', [order.id])).toBe(1);

    const order2 = await t.app.submitOrder.execute(cashier, takeaway(f));
    const different = await Promise.allSettled([
      t.app.recordPayment.execute(cashier, order2.id, {
        paymentId: uuid(),
        method: 'card',
        amount: order2.grandTotal,
      }),
      t.app.recordPayment.execute(cashier, order2.id, {
        paymentId: uuid(),
        method: 'cash',
        amount: order2.grandTotal,
      }),
    ]);
    expect(different.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const reason = (different.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
    expect(['ORDER_ALREADY_PAID', 'PAYMENT_EXCEEDS_BALANCE']).toContain(reason.code);
    expect(await count('payments where order_id = $1', [order2.id])).toBe(1);
    await assertConsistent(order.id);
    await assertConsistent(order2.id);
    results.push({
      case: 'D payments',
      outcome: `same id x2 -> 1 payment; two different full payments -> 1 accepted, 1 ${reason.code}`,
    });
  });

  it('E — two kitchen screens pressing READY on the same ticket: one wins, one ready event', async () => {
    const cashier = await t.as(f.authUsers.cashier);
    const order = await t.app.submitOrder.execute(cashier, takeaway(f, [line(f.products.jollof)]));
    const ticket = order.tickets[0]!;
    const kds = await t.as(f.authUsers.kitchenKds);
    const manager = await t.as(f.authUsers.manager);
    const outcomes = await Promise.allSettled([
      t.app.transitionTicket.execute(kds, ticket.id, { action: 'ready' }),
      t.app.transitionTicket.execute(manager, ticket.id, { action: 'ready' }),
    ]);
    const rejected = outcomes.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(['INVALID_TRANSITION', 'VERSION_CONFLICT']).toContain(rejected[0]!.reason.code);
    expect(
      await count(`production_ticket_events where ticket_id = $1 and action = 'ready'`, [ticket.id]),
    ).toBe(1);
    await assertConsistent(order.id);
    results.push({
      case: 'E 2 screens READY same ticket',
      outcome: `1 applied, 1 ${rejected[0]!.reason.code}; 1 ready event`,
    });
  });

  it('F — two agents claiming at once never hold the same print lease', async () => {
    const cashier = await t.as(f.authUsers.cashier);
    await Promise.all(Array.from({ length: 4 }, () => t.app.submitOrder.execute(cashier, takeaway(f))));
    const agent = await t.as(f.authUsers.agent);
    const [a, b] = await Promise.all([
      t.app.claimPrintJobs.execute(agent, { limit: 20 }),
      t.app.claimPrintJobs.execute(agent, { limit: 20 }),
    ]);
    const idsA = new Set(a.map((j) => j.id));
    const overlap = b.filter((j) => idsA.has(j.id));
    expect(overlap).toEqual([]);
    expect(a.length + b.length).toBeGreaterThan(0);
    // Each claimed job has exactly one live lease in the database, matching the claim handed out.
    for (const job of [...a, ...b]) {
      const [row] = await db.query<{ claim_id: string; status: string }>(
        'select claim_id, status from print_jobs where id = $1',
        [job.id],
      );
      expect(row).toMatchObject({ status: 'claimed', claim_id: job.claimId });
    }
    // Two agents reporting the same job at once: exactly one report is accepted.
    const job = a[0] ?? b[0]!;
    const reports = await Promise.allSettled([
      t.app.reportPrintJobResult.execute(agent, job.id, { claimId: job.claimId, outcome: 'printed' }),
      t.app.reportPrintJobResult.execute(agent, job.id, { claimId: job.claimId, outcome: 'printed' }),
    ]);
    expect(reports.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await count(`print_job_attempts where print_job_id = $1`, [job.id])).toBe(1);
    results.push({
      case: 'F parallel claims',
      outcome: `claims ${a.length} + ${b.length}, overlap 0; parallel reports -> 1 accepted, 1 attempt row`,
    });
  });

  it('G — waiter, cashier and kitchen changing one order at the same time leave it consistent', async () => {
    const waiter = await t.as(f.authUsers.waiter);
    const cashier = await t.as(f.authUsers.cashier);
    const manager = await t.as(f.authUsers.manager);
    const orderId = uuid();
    const base = { orderId, branchId: f.branchId, areaId: f.areas.hall, tableId: f.tables['12']! };
    const first = await t.app.submitOrder.execute(waiter, {
      ...base,
      items: [line(f.products.jollof, 2), line(f.products.coke, 2)],
      send: { submissionId: uuid() },
    });
    // Kitchen marks everything ready, waiter adds a round, cashier takes a partial payment: all at once.
    const outcomes = await Promise.allSettled([
      ...first.tickets.map((tk) => t.app.transitionTicket.execute(manager, tk.id, { action: 'ready' })),
      t.app.submitOrder.execute(waiter, {
        ...base,
        items: [line(f.products.meatPie, 1)],
        send: { submissionId: uuid() },
      }),
      t.app.recordPayment.execute(cashier, orderId, { paymentId: uuid(), method: 'cash', amount: 5000 }),
    ]);
    const failures = outcomes.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    // Serialised on the order row: nothing should fail, and nothing should be lost.
    expect(failures.map((f) => f.reason?.code ?? String(f.reason))).toEqual([]);
    const view = await t.app.getOrder.execute(manager, orderId);
    expect(view.items).toHaveLength(3);
    expect(view.status).toBe('partially_ready'); // the new pie is not ready yet
    expect(view.paidTotal).toBe(5000);
    await assertConsistent(orderId);

    // Two people hand the order over simultaneously once everything is ready.
    const pie = view.tickets.find((tk) => tk.status !== 'ready')!;
    await t.app.transitionTicket.execute(manager, pie.id, { action: 'ready' });
    const serves = await Promise.allSettled([
      t.app.fulfilOrder.execute(waiter, orderId, {}),
      t.app.fulfilOrder.execute(cashier, orderId, {}),
    ]);
    expect(serves.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((serves.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe(
      'NOTHING_TO_FULFIL',
    );
    await assertConsistent(orderId);
    results.push({
      case: 'G mixed writers on one order',
      outcome:
        '5 concurrent writes all applied, state consistent; double serve -> 1 applied, 1 NOTHING_TO_FULFIL',
    });
  });

  it('parallel transactions for two tenants through the pooler never leak data', async () => {
    const aCashier = await t.as(f.authUsers.cashier);
    const bCashier = await t.as(other.authUsers.cashier);
    const tasks = Array.from({ length: 16 }, (_, i) =>
      i % 2 === 0
        ? t.app.listActiveOrders.execute(aCashier, f.branchId).then((rows) => ({ tenant: 'A', rows }))
        : t.app.submitOrder
            .execute(bCashier, takeaway(other))
            .then(() => t.app.listActiveOrders.execute(bCashier, other.branchId))
            .then((rows) => ({ tenant: 'B', rows })),
    );
    const out = await Promise.all(tasks);
    const aIds = new Set(
      (
        await db.query<{ id: string }>('select id from orders where restaurant_id = $1', [f.restaurantId])
      ).map((r) => r.id),
    );
    const bIds = new Set(
      (
        await db.query<{ id: string }>('select id from orders where restaurant_id = $1', [other.restaurantId])
      ).map((r) => r.id),
    );
    for (const r of out) {
      const own = r.tenant === 'A' ? aIds : bIds;
      expect(r.rows.every((o) => own.has(o.id))).toBe(true);
    }
    results.push({
      case: 'tenant isolation under parallel pooled transactions',
      outcome: '16 interleaved A/B transactions; 0 foreign rows returned',
    });
  });
});
