import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createHttpHarness } from '../../api/test/harness';
import { createHub } from '../src/server';

/**
 * Test server for the hub browser tests: an in-process MY FOOD cloud (test harness, PGlite) and a
 * real MY FOOD Hub serving the real web build (apps/web/dist) on http://127.0.0.1:8790.
 * /__test/offline and /__test/online cut and restore the hub's connection to the cloud.
 */
const PORT = 8790;
const cloud = await createHttpHarness();
const { f, t, db } = cloud;
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
await db.query('update staff set pin_must_change = false');

let online = true;
const hub = await createHub({
  dataDir: mkdtempSync(join(tmpdir(), 'myfood-hub-e2e-')),
  migrationsDir: resolve('supabase/migrations'),
  webDist: resolve('apps/web/dist'),
  cloudApiUrl: 'http://api.test',
  supabaseUrl: 'https://test-project.supabase.co',
  secrets: { jwtSecret: 'e2e-hub-secret-'.repeat(4), pinPepper: 'e2e-hub-pepper-'.repeat(4) },
  cloudToken: () => cloud.token(hubUser),
  cloudFetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (!online) throw new TypeError('fetch failed (no internet)');
    return cloud.fetch(input, init);
  }) as typeof fetch,
  // Printers in the fixture are fake addresses: print failures are expected and not logged.
  logger: { info: () => {}, warn: () => {}, error: (e, x) => console.error(e, x) },
  release: 'hub-e2e',
  port: PORT,
});
const stop = await hub.start();
setInterval(() => void hub.engine.syncOnce(), 3000);

serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch: async (req, env) => {
    const url = new URL(req.url);
    if (url.pathname === '/__test/offline' || url.pathname === '/__test/online') {
      online = url.pathname.endsWith('online');
      await hub.engine.syncOnce();
      return Response.json({ online });
    }
    if (url.pathname === '/__test/cloud-orders') {
      const rows = await db.query<{ order_number: number }>(
        'select order_number from orders order by order_number',
      );
      return Response.json(rows.map((r) => r.order_number));
    }
    return hub.fetch(req, env);
  },
});
console.log(`hub e2e server on http://127.0.0.1:${PORT}`);
process.on('SIGTERM', () => {
  stop();
  process.exit(0);
});
