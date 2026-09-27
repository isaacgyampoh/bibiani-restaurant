import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ApiClient } from '@rp/client-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpHarness, type HttpHarness } from '../../api/test/harness';
import { FakePrinter } from '../../print-agent/test/fake-printer';
import { createHub } from '../src/server';

/**
 * Printing through the hub, end to end over real TCP: till order -> hub -> routing -> print queue ->
 * the print agent inside the hub -> network "printers" (fake ESC/POS printers on port sockets).
 * This verifies the software path; it is NOT a test of a physical printer.
 */
describe('MY FOOD Hub printing over the network', () => {
  let cloud: HttpHarness;
  let hub: Awaited<ReturnType<typeof createHub>>;
  let stop: () => void;
  let dataDir: string;
  let staffToken = '';
  const printers = {
    drinks: new FakePrinter(),
    kitchen: new FakePrinter(),
    pastry: new FakePrinter(),
    backup: new FakePrinter(),
  };

  const hubFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    hub.fetch(new Request(new URL(String(input), 'http://hub.local'), init))) as typeof fetch;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) =>
    (await hubFetch(`http://hub.local${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }).then((r) => r.json())) as Record<string, any>;
  const until = async (check: () => Promise<boolean> | boolean, ms = 45_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('timed out waiting');
  };
  const sell = async (productId: string) => {
    const cashier = new ApiClient({
      baseUrl: 'http://hub.local',
      getAccessToken: async () => staffToken,
      fetch: hubFetch,
      deviceId: cloud.f.devices.pos,
    });
    return cashier.submitOrder({
      orderId: randomUUID(),
      branchId: cloud.f.branchId,
      areaId: cloud.f.areas.takeaway,
      items: [{ id: randomUUID(), productId, quantity: 2, modifierIds: [], notes: null }],
      send: { submissionId: randomUUID() },
    });
  };
  const jobs = (orderId: string) =>
    hub.db.query<{ status: string; printer_id: string; attempts: number }>(
      `select status, printer_id, attempts from print_jobs where order_id = $1 and kind = 'kitchen_ticket'`,
      [orderId],
    );
  const received = (p: FakePrinter, orderNumber: number) =>
    p.jobs.filter((j) => j.toString('latin1').includes(`ORDER #${orderNumber}`)).length;

  beforeAll(async () => {
    for (const p of Object.values(printers)) await p.start();
    cloud = await createHttpHarness();
    const { f, t, db } = cloud;
    // The branch's printers point at the fake printers on this machine.
    for (const [key, fake] of Object.entries(printers))
      await db.query('update printers set address = $2 where device_id = $1', [
        f.printers[key as keyof typeof printers],
        `127.0.0.1:${fake.port}`,
      ]);
    const hubUser = randomUUID();
    await db.query('insert into auth.users (id) values ($1)', [hubUser]);
    const [{ id: hubDeviceId }] = (await db.query<{ id: string }>(
      `insert into devices (restaurant_id, branch_id, kind, name, auth_user_id) values ($1, $2, 'hub', 'HUB-01', $3) returning id`,
      [f.restaurantId, f.branchId, hubUser],
    )) as [{ id: string }];
    const owner = await t.as(f.authUsers.manager);
    await t.app.setBranchHub.execute(owner, f.branchId, { hubDeviceId });
    const staffId = async (user: string) =>
      (await db.query<{ id: string }>('select id from staff where user_id = $1', [user]))[0]!.id;
    await t.app.assignStaffPin.execute(owner, await staffId(f.authUsers.cashier), '4827');
    await t.app.assignStaffPin.execute(owner, await staffId(f.authUsers.manager), '9153');

    dataDir = mkdtempSync(join(tmpdir(), 'myfood-hub-print-'));
    const web = join(dataDir, 'web');
    mkdirSync(web, { recursive: true });
    writeFileSync(join(web, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
    // The in-hub print agent calls the hub over HTTP, so the hub listens on a real port here.
    const { serve } = await import('@hono/node-server');
    let port = 0;
    const server = serve({ fetch: (req, env) => hub.fetch(req, env), port: 0, hostname: '127.0.0.1' });
    await new Promise((r) => setTimeout(r, 50));
    port = (server.address() as { port: number }).port;
    hub = await createHub({
      dataDir: join(dataDir, 'hub'),
      migrationsDir: resolve(__dirname, '../../../supabase/migrations'),
      webDist: web,
      cloudApiUrl: 'http://api.test',
      supabaseUrl: 'https://test-project.supabase.co',
      secrets: { jwtSecret: `jwt-${randomUUID()}-${randomUUID()}`, pinPepper: `pepper-${randomUUID()}` },
      cloudToken: () => cloud.token(hubUser),
      cloudFetch: cloud.fetch,
      isConsoleRequest: (c) => c.req.header('x-test-console') === '1',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      release: 'hub-print-test',
      port,
    });
    const stopHub = await hub.start();
    stop = () => {
      stopHub();
      server.close();
    };

    // Pair the till at the hub and sign the cashier in.
    const { code, secret } = await post('/v1/devices/pairing-requests', {});
    await post(
      '/hub/console/approve-pairing',
      { deviceId: f.devices.pos, code, managerPin: '9153' },
      { 'x-test-console': '1' },
    );
    const till = (await post('/v1/devices/pairing-requests/collect', { secret })).session
      .accessToken as string;
    const pin = await new ApiClient({
      baseUrl: 'http://hub.local',
      getAccessToken: async () => till,
      fetch: hubFetch,
    }).pinSignIn('4827');
    staffToken = pin.session.accessToken;
  }, 120_000);

  afterAll(async () => {
    stop?.();
    await hub?.db.close();
    await cloud?.db.close();
    for (const p of Object.values(printers)) await p.stop();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('a kitchen ticket reaches its station printer with order number, items and prices', async () => {
    const order = await sell(cloud.f.products.coke);
    await until(() => received(printers.drinks, order.orderNumber) === 1);
    const text = printers.drinks.jobs
      .map((j) => j.toString('latin1'))
      .find((t) => t.includes(`ORDER #${order.orderNumber}`))!;
    expect(text).toContain('COKE');
    expect(text).toMatch(/2\s*x/i);
    await until(async () => (await jobs(order.id)).every((j) => j.status === 'printed'));
    expect(received(printers.kitchen, order.orderNumber)).toBe(0);
  }, 60_000);

  it('printer switched off: the ticket waits and is visible, then prints once when the printer is back', async () => {
    const port = printers.kitchen.port;
    await printers.kitchen.stop();
    const order = await sell(cloud.f.products.jollof);
    await until(async () => (await jobs(order.id)).some((j) => j.status === 'failed' && j.attempts >= 1));
    expect(received(printers.kitchen, order.orderNumber)).toBe(0);

    await printers.kitchen.start(port);
    await until(async () => (await jobs(order.id)).every((j) => j.status === 'printed'));
    // Give any stray retry a chance to show up: still exactly one copy.
    await new Promise((r) => setTimeout(r, 4000));
    expect(received(printers.kitchen, order.orderNumber)).toBe(1);
  }, 90_000);

  it('main printer stays down: the ticket moves to the backup printer, printed once', async () => {
    await printers.pastry.stop();
    const order = await sell(cloud.f.products.meatPie);
    await until(
      async () =>
        (await jobs(order.id)).some(
          (j) => j.status === 'printed' && j.printer_id === cloud.f.printers.backup,
        ),
      80_000,
    );
    expect(received(printers.backup, order.orderNumber)).toBe(1);
    expect(received(printers.pastry, order.orderNumber)).toBe(0);
  }, 100_000);
});
