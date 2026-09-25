import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createApplication } from '@rp/application';
import { ApiClient, type ChangeSignal, ReconcilingFeed, SupabaseBroadcastSignal } from '@rp/client-core';
import type { StationBoardView } from '@rp/contracts';
import {
  createJsonLogger,
  createPostgresDatabase,
  JwksTokenVerifier,
  PgPrincipalResolver,
  PgUnitOfWork,
  randomIds,
  sha256Fingerprinter,
  systemClock,
} from '@rp/infrastructure';
import {
  createTestDatabase,
  fixtureCredentials,
  HOSTED,
  type RestaurantFixture,
  seedRestaurant,
  type TestDatabase,
} from '@rp/testing';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApp } from '../src';

/**
 * Hosted-only: real Supabase Auth sessions, real Supabase Realtime private
 * channels, real API server using the least-privilege rp_api login.
 */
const URL_ = process.env.SUPABASE_URL!;
const ANON = process.env.SUPABASE_ANON_KEY!;
const uuid = () => randomUUID();

interface Received {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  at: number;
}

async function signIn(authUserId: string): Promise<SupabaseClient> {
  const creds = fixtureCredentials.get(authUserId)!;
  const client = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword(creds);
  if (error || !data.session) throw new Error(`sign-in failed: ${error?.message}`);
  await client.realtime.setAuth(data.session.access_token);
  return client;
}

/** Subscribes to a private topic and records everything delivered. Resolves with the final status. */
function listen(client: SupabaseClient, topic: string, sink: Received[]): Promise<string> {
  return new Promise((resolve) => {
    client
      .channel(topic, { config: { private: true } })
      .on('broadcast', { event: '*' }, (msg) =>
        sink.push({
          topic,
          event: msg.event,
          payload: (msg.payload ?? {}) as Record<string, unknown>,
          at: Date.now(),
        }),
      )
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') resolve(status);
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
          resolve(`${status}${err ? `: ${err.message}` : ''}`);
      });
  });
}

async function waitFor<T>(fn: () => T | undefined, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('timed out waiting for realtime message');
}

describe.skipIf(!HOSTED)('Supabase Realtime with authenticated clients (hosted DEV)', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let stranger: RestaurantFixture;
  let apiDb: ReturnType<typeof createPostgresDatabase>;
  let server: ReturnType<typeof serve>;
  let baseUrl: string;
  const clients: SupabaseClient[] = [];
  const report: string[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    [f, stranger] = await Promise.all([
      seedRestaurant(db, { slug: 'rt' }),
      seedRestaurant(db, { slug: 'rt-other' }),
    ]);
    if (process.env.API_BASE_URL) {
      // Deployed API (staging): the real chain POS -> deployed API -> Supabase -> KDS.
      baseUrl = process.env.API_BASE_URL.replace(/\/$/, '');
      return;
    }
    // In-process API exactly as in production: rp_api login, JWKS verification.
    apiDb = createPostgresDatabase(process.env.DATABASE_URL!, { max: 5 });
    const logger = createJsonLogger({ service: 'api-test' }, () => undefined);
    const app = createApplication({
      uow: new PgUnitOfWork(apiDb, { statementTimeoutMs: 60_000, lockTimeoutMs: 60_000 }),
      clock: systemClock,
      ids: randomIds,
      fingerprint: sha256Fingerprinter,
      logger,
    });
    const http = createHttpApp({
      app,
      verifier: new JwksTokenVerifier(URL_),
      resolver: new PgPrincipalResolver(apiDb),
      logger,
    });
    await new Promise<void>((resolve) => {
      server = serve({ fetch: http.fetch, port: 0 }, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    console.log(`\nREALTIME RESULTS\n${report.map((r) => `  ${r}`).join('\n')}`);
    for (const c of clients) await c.removeAllChannels();
    report.unshift(`API under test: ${baseUrl}`);
    server?.close();
    await apiDb?.close();
    await db?.close();
  });

  const api = (client: SupabaseClient, deviceId?: string) =>
    new ApiClient({
      baseUrl,
      timeoutMs: 60_000, // the test machine is ~140 ms from the database; production API is co-located
      deviceId: deviceId ?? null,
      getAccessToken: async () => (await client.auth.getSession()).data.session!.access_token,
    });

  it('POS -> KDS -> POS -> customer display -> admin: each receives its signal; outsiders are refused', async () => {
    const [pos, kds, display, admin, outsider] = await Promise.all([
      signIn(f.authUsers.cashier),
      signIn(f.authUsers.kitchenKds),
      signIn(f.authUsers.display),
      signIn(f.authUsers.manager),
      signIn(stranger.authUsers.manager),
    ]);
    clients.push(pos, kds, display, admin, outsider);
    const got: Received[] = [];
    const topics = {
      orders: `branch:${f.branchId}:orders`,
      kitchen: `branch:${f.branchId}:station:${f.stations.kitchen}`,
      ops: `branch:${f.branchId}:ops`,
    };
    const statuses = await Promise.all([
      listen(pos, topics.orders, got),
      listen(kds, topics.kitchen, got),
      listen(display, topics.orders, got),
      listen(admin, topics.ops, got),
    ]);
    expect(statuses).toEqual(['SUBSCRIBED', 'SUBSCRIBED', 'SUBSCRIBED', 'SUBSCRIBED']);
    const outsiderGot: Received[] = [];
    const outsiderStatus = await listen(outsider, topics.orders, outsiderGot);
    report.push(`outsider (other restaurant) joining ${topics.orders}: ${outsiderStatus}`);
    expect(outsiderStatus).not.toBe('SUBSCRIBED');

    // POS creates an order through the API
    const t0 = Date.now();
    const order = await api(pos).submitOrder({
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [{ id: uuid(), productId: f.products.jollof, quantity: 1, modifierIds: [] }],
      send: { submissionId: uuid() },
    });
    report.push(`POS submit API call took ${Date.now() - t0} ms from the test machine`);
    const kdsMsg = await waitFor(() =>
      got.find((m) => m.topic === topics.kitchen && m.payload.order_id === order.id),
    );
    report.push(
      `POS submit -> KDS ticket_changed in ${kdsMsg.at - t0} ms (includes API round trips from test machine)`,
    );
    expect(kdsMsg.event).toBe('ticket_changed');

    // KDS marks ready -> POS and customer display both hear about it
    const t1 = Date.now();
    await api(kds).ticketAction(order.tickets[0]!.id, { action: 'ready' });
    const readyMsgs = await waitFor(() => {
      const m = got.filter(
        (x) => x.topic === topics.orders && x.payload.order_id === order.id && x.payload.status === 'ready',
      );
      return m.length >= 2 ? m : undefined;
    });
    report.push(
      `KDS ready -> POS + customer display order_changed(ready) in ${Math.max(...readyMsgs.map((m) => m.at)) - t1} ms`,
    );

    // The display then reads authoritative state (numbers only)
    const board = await api(display).customerBoard(f.branchId);
    expect(board.ready.map((r) => r.orderNumber)).toContain(order.orderNumber);

    // Printer state change -> admin ops view
    const agent = await signIn(f.authUsers.agent);
    clients.push(agent);
    const t2 = Date.now();
    await api(agent).heartbeat({
      appVersion: 'test',
      printers: [{ printerId: f.printers.grill, ok: false, error: 'paper out' }],
    });
    const opsMsg = await waitFor(() =>
      got.find((m) => m.topic === topics.ops && m.event === 'printer_changed'),
    );
    report.push(`printer error -> admin printer_changed in ${opsMsg.at - t2} ms`);
    expect(opsMsg.payload).toMatchObject({ printer_id: f.printers.grill, healthy: false });

    // Payloads carry ids/status only (no names, phones or totals)
    expect(JSON.stringify(got)).not.toMatch(/customer_name|grand_total|phone/);
    // The outsider never received anything from this branch
    expect(outsiderGot).toEqual([]);
  });

  it('disconnect -> changes missed -> reconnect: client detects it, reloads state, resumes live updates', async () => {
    const kds = await signIn(f.authUsers.kitchenKds);
    const pos = await signIn(f.authUsers.cashier);
    clients.push(kds, pos);
    const topic = `branch:${f.branchId}:station:${f.stations.kitchen}`;
    const signal: ChangeSignal = new SupabaseBroadcastSignal(kds, topic);
    const states: { connection: string; tickets: number }[] = [];
    const feed = new ReconcilingFeed<StationBoardView>({
      load: () => api(kds).stationBoard(f.stations.kitchen),
      signal,
      pollIntervalMs: 60_000, // long on purpose: this test proves the realtime + reconnect path, not the poll
      onState: (s) => states.push({ connection: s.connection, tickets: s.data?.tickets.length ?? -1 }),
    });
    await feed.start();
    await waitFor(() => (feed.current.connection === 'live' ? true : undefined));
    const baseline = feed.current.data!.tickets.length;

    // Live path: a new order reaches the KDS through realtime -> reload.
    await api(pos).submitOrder({
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [{ id: uuid(), productId: f.products.jollof, quantity: 1, modifierIds: [] }],
      send: { submissionId: uuid() },
    });
    await waitFor(() => (feed.current.data!.tickets.length === baseline + 1 ? true : undefined));
    report.push('live: new ticket appeared on KDS via realtime signal -> authoritative reload');

    // Drop the socket, create orders while offline.
    kds.realtime.disconnect();
    await waitFor(() => (feed.current.connection === 'polling' ? true : undefined));
    const missed = await api(pos).submitOrder({
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [{ id: uuid(), productId: f.products.jollof, quantity: 2, modifierIds: [] }],
      send: { submissionId: uuid() },
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(feed.current.data!.tickets.some((tk) => tk.orderId === missed.id)).toBe(false); // stale while offline

    // Reconnect: supabase-js rejoins the channel; the feed sees 'connected' and reloads from the API.
    kds.realtime.connect();
    await waitFor(
      () => (feed.current.data!.tickets.some((tk) => tk.orderId === missed.id) ? true : undefined),
      30_000,
    );
    expect(feed.current.connection).toBe('live');
    report.push(
      'offline: missed order; reconnect -> detected, reloaded, reconciled (missed ticket now shown), live again',
    );

    // Resumed: the next change arrives live again.
    const after = await api(pos).submitOrder({
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [{ id: uuid(), productId: f.products.sandwich, quantity: 1, modifierIds: [] }],
      send: { submissionId: uuid() },
    });
    await waitFor(() =>
      feed.current.data!.tickets.some((tk) => tk.orderId === after.id) ? true : undefined,
    );
    report.push('after reconnect: subscription resumed (next order arrived live)');
    feed.stop();
  });
});
