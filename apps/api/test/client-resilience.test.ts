import { randomUUID } from 'node:crypto';
import { type ChangeSignal, MemoryOutboxStore, Outbox, ReconcilingFeed } from '@rp/client-core';
import type { OrderView, StationBoardView } from '@rp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpHarness, type HttpHarness } from './harness';

const uuid = () => randomUUID();

/** Controllable stand-in for Supabase Realtime: the test decides when the socket is up and what it delivers. */
class ControlledSignal implements ChangeSignal {
  private change: (() => void) | null = null;
  private status: ((s: 'connected' | 'disconnected') => void) | null = null;
  subscribe(onChange: () => void, onStatus: (s: 'connected' | 'disconnected') => void) {
    this.change = onChange;
    this.status = onStatus;
    onStatus('connected');
    return () => {
      this.change = null;
    };
  }
  emit() {
    this.change?.();
  }
  drop() {
    this.status?.('disconnected');
  }
  restore() {
    this.status?.('connected');
  }
}

class ManualTimers {
  private fns: (() => void)[] = [];
  setInterval(fn: () => void) {
    this.fns.push(fn);
    return this.fns.length - 1;
  }
  clearInterval() {
    this.fns = [];
  }
  tick() {
    for (const fn of this.fns) fn();
  }
}

describe('Client resilience against the real API', () => {
  let h: HttpHarness;
  beforeAll(async () => {
    h = await createHttpHarness();
  });
  afterAll(() => h.db.close());

  const newOrder = (productId: string) => ({
    orderId: uuid(),
    branchId: h.f.branchId,
    areaId: h.f.areas.takeaway,
    items: [{ id: uuid(), productId, quantity: 1, modifierIds: [] }],
    send: { submissionId: uuid() },
  });

  it('TEST 8 — KDS misses events while disconnected, then reconciles from the database', async () => {
    const kds = h.client(h.f.authUsers.kitchenKds);
    const cashier = h.client(h.f.authUsers.cashier);
    const signal = new ControlledSignal();
    const timers = new ManualTimers();
    const states: StationBoardView[] = [];
    const feed = new ReconcilingFeed({
      load: () => kds.stationBoard(h.f.stations.kitchen),
      signal,
      pollIntervalMs: 20_000,
      timers,
      onState: (s) => s.data && states.push(s.data),
    });
    await feed.start();
    expect(feed.current.connection).toBe('live');
    const before = feed.current.data!.tickets.length;

    // Socket drops. Two orders arrive; their events are never delivered.
    signal.drop();
    expect(feed.current.connection).toBe('polling');
    const a = await cashier.submitOrder(newOrder(h.f.products.jollof));
    const b = await cashier.submitOrder(newOrder(h.f.products.sandwich));
    expect(feed.current.data!.tickets.length).toBe(before); // stale, as expected

    // Reconnect -> full reload from the API, no event replay needed.
    signal.restore();
    await feed.refresh();
    const ids = feed.current.data!.tickets.map((t) => t.orderId);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));

    // Silent socket death: no status change, no events. The safety poll still catches up.
    const c = await cashier.submitOrder(newOrder(h.f.products.jollof));
    timers.tick();
    await feed.refresh();
    expect(feed.current.data!.tickets.map((t) => t.orderId)).toContain(c.id);
    feed.stop();
  });

  it('a lost response is replayed from the outbox without duplicating the order or payment', async () => {
    const realFetch = h.fetch;
    let dropResponses = true;
    // The server processes the request, but the POS never sees the answer (Wi-Fi died on the way back).
    const flakyFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await realFetch(input, init);
      if (dropResponses) throw new TypeError('network connection lost');
      return res;
    }) as typeof fetch;
    const pos = h.client(h.f.authUsers.cashier, { fetch: flakyFetch });

    const order = newOrder(h.f.products.chicken);
    const paymentId = uuid();
    const outbox = new Outbox(new MemoryOutboxStore(), {
      submit_order: (e) => pos.submitOrder(e.payload as typeof order),
      record_payment: (e) => {
        const p = e.payload as { orderId: string; paymentId: string };
        return pos.recordPayment(p.orderId, { paymentId: p.paymentId, method: 'cash', tendered: 10000 });
      },
    });
    await outbox.enqueue({ id: uuid(), key: order.orderId, kind: 'submit_order', payload: order });
    await outbox.enqueue({
      id: uuid(),
      key: order.orderId,
      kind: 'record_payment',
      payload: { orderId: order.orderId, paymentId },
    });

    const first = await outbox.flush();
    expect(first.sent).toEqual([]);
    expect(first.waiting).toHaveLength(2); // payment waits behind the order: ordering preserved

    dropResponses = false;
    await outbox.flush(); // order replay (already exists server-side) then payment
    await outbox.flush(); // payment replay path when its first attempt also got through
    expect(await outbox.pending()).toEqual([]);

    const counts = await h.db.query<{ orders: number; tickets: number; payments: number }>(
      `select (select count(*)::int from orders where id = $1) as orders,
              (select count(*)::int from production_tickets where order_id = $1) as tickets,
              (select count(*)::int from payments where order_id = $1) as payments`,
      [order.orderId],
    );
    expect(counts[0]).toEqual({ orders: 1, tickets: 1, payments: 1 });
    const view: OrderView = await h.client(h.f.authUsers.cashier).getOrder(order.orderId);
    expect(view.paymentStatus).toBe('paid');
  });

  it('a permanent rejection is kept for a person to resolve, never dropped', async () => {
    const pos = h.client(h.f.authUsers.cashier);
    const outbox = new Outbox(new MemoryOutboxStore(), {
      submit_order: (e) => pos.submitOrder(e.payload as never),
    });
    const bad = {
      ...newOrder(h.f.products.jollof),
      items: [{ id: uuid(), productId: uuid(), quantity: 1, modifierIds: [] }],
    };
    await outbox.enqueue({ id: 'op-1', key: bad.orderId, kind: 'submit_order', payload: bad });
    const result = await outbox.flush();
    expect(result.needsAttention).toEqual(['op-1']);
    const [entry] = await outbox.pending();
    expect(entry).toMatchObject({ state: 'needs_attention', attempts: 1 });
    expect(entry!.lastError).toBe('A product on this order no longer exists');
  });
});
