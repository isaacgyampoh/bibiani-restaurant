import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ApiClient } from '@rp/client-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpHarness, type HttpHarness } from '../../api/test/harness';
import { createHub } from '../src/server';

/**
 * The hub as the browser and the cloud see it: over HTTP only. The cloud is the real API (test
 * harness); the hub is the real hub server with its own embedded database.
 */
describe('MY FOOD Hub over HTTP', () => {
  let cloud: HttpHarness;
  let hub: Awaited<ReturnType<typeof createHub>>;
  let stop: () => void;
  let dataDir: string;
  let online = true;
  let hubUser: string;
  const hubFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    hub.fetch(new Request(new URL(String(input), 'http://hub.local'), init))) as typeof fetch;
  const local = (token: () => Promise<string>, deviceId: string | null = null) =>
    new ApiClient({ baseUrl: 'http://hub.local', getAccessToken: token, fetch: hubFetch, deviceId });
  const json = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await hubFetch(`http://hub.local${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
  };

  beforeAll(async () => {
    cloud = await createHttpHarness();
    const { f, t, db } = cloud;
    hubUser = randomUUID();
    await db.query('insert into auth.users (id) values ($1)', [hubUser]);
    const [{ id: hubDeviceId }] = (await db.query<{ id: string }>(
      `insert into devices (restaurant_id, branch_id, kind, name, auth_user_id) values ($1, $2, 'hub', 'HUB-01', $3) returning id`,
      [f.restaurantId, f.branchId, hubUser],
    )) as [{ id: string }];
    const owner = await t.as(f.authUsers.manager);
    await t.app.setBranchHub.execute(owner, f.branchId, { hubDeviceId });
    // PINs are set in the back office.
    const staffId = async (user: string) =>
      (await db.query<{ id: string }>('select id from staff where user_id = $1', [user]))[0]!.id;
    await t.app.assignStaffPin.execute(owner, await staffId(f.authUsers.cashier), '4827');
    await t.app.assignStaffPin.execute(owner, await staffId(f.authUsers.manager), '9153');

    dataDir = mkdtempSync(join(tmpdir(), 'myfood-hub-'));
    const web = join(dataDir, 'web');
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(
      join(web, 'index.html'),
      '<!doctype html><html><head><title>MY FOOD</title></head><body></body></html>',
    );
    writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
    hub = await createHub({
      dataDir: join(dataDir, 'hub'),
      migrationsDir: resolve(__dirname, '../../../supabase/migrations'),
      webDist: web,
      cloudApiUrl: 'http://api.test',
      supabaseUrl: 'https://test-project.supabase.co',
      secrets: { jwtSecret: 'x'.repeat(48), pinPepper: 'hub-pepper-'.repeat(4) },
      cloudToken: () => cloud.token(hubUser),
      cloudFetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (!online) throw new TypeError('fetch failed (no internet)');
        return cloud.fetch(input, init);
      }) as typeof fetch,
      isConsoleRequest: (c) => c.req.header('x-test-console') === '1',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      release: 'hub-test',
      port: 0,
    });
    stop = await hub.start();
  }, 120_000);
  afterAll(async () => {
    stop?.();
    await hub?.db.close();
    await cloud?.db.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  let tillToken = '';
  let staffToken = '';

  it('serves the web app marked as a hub page, with a strict content security policy', async () => {
    const res = await hubFetch('http://hub.local/pos');
    const html = await res.text();
    expect(html).toContain('<meta name="myfood-hub" content="1">');
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self'");
    const asset = await hubFetch('http://hub.local/assets/app.js');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    // Encoded "..": never escapes the web folder (the hub's secrets live next to it).
    writeFileSync(join(dataDir, 'secret.txt'), 'do-not-serve');
    const traversal = await hubFetch('http://hub.local/assets/%2e%2e/%2e%2e/secret.txt');
    expect(await traversal.text()).not.toContain('do-not-serve');
  });

  it('reports its sync state', async () => {
    const { body } = await json('/hub/status');
    expect(body.cloud).toBe('connected');
    expect(body.identity.attached).toBe(true);
  });

  it('pairs a till at the hub: the till shows a code, a manager approves it on the hub PC with their PIN', async () => {
    const request = await json('/v1/devices/pairing-requests', {});
    expect(request.status).toBe(200);
    const { code, secret } = request.body as { code: string; secret: string };

    // Not from another machine on the network.
    expect(
      (
        await json('/hub/console/approve-pairing', {
          deviceId: cloud.f.devices.pos,
          code,
          managerPin: '9153',
        })
      ).status,
    ).toBe(403);
    // A cashier's PIN cannot approve devices.
    const byCashier = await json(
      '/hub/console/approve-pairing',
      { deviceId: cloud.f.devices.pos, code, managerPin: '4827' },
      { 'x-test-console': '1' },
    );
    expect(byCashier.status).toBe(403);
    const approved = await json(
      '/hub/console/approve-pairing',
      { deviceId: cloud.f.devices.pos, code, managerPin: '9153' },
      { 'x-test-console': '1' },
    );
    expect(approved.body).toEqual({ ok: true });

    const collected = await json('/v1/devices/pairing-requests/collect', { secret });
    expect(collected.body.status).toBe('paired');
    tillToken = collected.body.session.accessToken;
    // The till's login is the hub's own: the cloud does not accept it.
    const atCloud = await cloud.fetch('http://api.test/v1/me', {
      headers: { authorization: `Bearer ${tillToken}` },
    });
    expect(atCloud.status).toBe(401);
  });

  it('PIN sign-in on the till (learnt from the cloud the first time), then selling through the hub', async () => {
    const till = local(async () => tillToken);
    const session = await till.pinSignIn('4827');
    expect(session.mustChangePin).toBe(true);
    staffToken = session.session.accessToken;
    const cashier = local(async () => staffToken, cloud.f.devices.pos);
    const order = await cashier.submitOrder({
      orderId: randomUUID(),
      branchId: cloud.f.branchId,
      areaId: cloud.f.areas.takeaway,
      items: [
        { id: randomUUID(), productId: cloud.f.products.jollof, quantity: 1, modifierIds: [], notes: null },
      ],
      send: { submissionId: randomUUID() },
    });
    await cashier.recordPayment(order.id, { paymentId: randomUUID(), method: 'cash', tendered: 10000 });
    await hub.engine.syncOnce();
    const [{ n }] = (await cloud.db.query<{ n: number }>(
      'select count(*)::int as n from orders where id = $1',
      [order.id],
    )) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('internet down: sign-in with a known PIN and selling keep working; the order syncs when it returns', async () => {
    online = false;
    await hub.engine.syncOnce();
    expect((await json('/hub/status')).body.cloud).toBe('offline');
    const till = local(async () => tillToken);
    const session = await till.pinSignIn('4827');
    const cashier = local(async () => session.session.accessToken, cloud.f.devices.pos);
    const order = await cashier.submitOrder({
      orderId: randomUUID(),
      branchId: cloud.f.branchId,
      areaId: cloud.f.areas.takeaway,
      items: [
        { id: randomUUID(), productId: cloud.f.products.coke, quantity: 2, modifierIds: [], notes: null },
      ],
      send: { submissionId: randomUUID() },
    });
    await cashier.recordPayment(order.id, { paymentId: randomUUID(), method: 'cash', tendered: 5000 });
    expect((await json('/hub/status')).body.outbox.pending).toBeGreaterThan(0);

    online = true;
    await hub.engine.syncOnce();
    expect((await json('/hub/status')).body.outbox.pending).toBe(0);
    const [{ n }] = (await cloud.db.query<{ n: number }>(
      'select count(*)::int as n from payments where order_id = $1',
      [order.id],
    )) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('hub sessions: refresh tokens rotate (an old one stops working), the user endpoint answers', async () => {
    const till = local(async () => tillToken);
    const session = await till.pinSignIn('4827');
    const refresh = (token: string) =>
      hubFetch('http://hub.local/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: token }),
      });
    const first = await refresh(session.session.refreshToken);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { access_token: string; user: { id: string } };
    expect(body.user.id).toBe(cloud.f.authUsers.cashier);
    expect((await refresh(session.session.refreshToken)).status).toBe(400);
    const user = await hubFetch('http://hub.local/auth/v1/user', {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(((await user.json()) as { id: string }).id).toBe(cloud.f.authUsers.cashier);
    expect(
      (
        await hubFetch('http://hub.local/auth/v1/user', {
          headers: { authorization: 'Bearer forged.token.value' },
        })
      ).status,
    ).toBe(401);
  });

  it('a PIN session on the hub cannot manage staff, devices or settings', async () => {
    const res = await hubFetch('http://hub.local/v1/admin/configuration', {
      headers: { authorization: `Bearer ${staffToken}` },
    });
    expect(res.status).toBe(403);
  });
});
