import { randomUUID } from 'node:crypto';
import { HubPinService, openLocalDatabase, SyncEngine } from '@rp/hub';
import type { Database } from '@rp/infrastructure';
import { HmacPinHasher } from '@rp/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPgliteInstance,
  createTestApp,
  createTestDatabase,
  MIGRATIONS_DIR,
  type RestaurantFixture,
  seedRestaurant,
  type TestApp,
  type TestDatabase,
} from '../src';
import { line, uuid } from './helpers';

/** Offline staff sign-in on the in-store hub (docs/OFFLINE-AUTHENTICATION.md). */
describe('in-store hub: offline PIN sign-in', () => {
  const HUB_PEPPER = 'hub-only-pepper-fedcba9876543210fedcba9876543210';
  let cloudDb: TestDatabase;
  let hubDb: Database;
  let f: RestaurantFixture;
  let cloud: TestApp;
  let hub: TestApp;
  let engine: SyncEngine;
  let pins: HubPinService;
  let hubUser: string;
  let cashierStaff: string;
  let online = true;
  const offline = () => new Error('getaddrinfo ENOTFOUND (no internet)');

  beforeAll(async () => {
    cloudDb = await createTestDatabase();
    f = await seedRestaurant(cloudDb, { slug: 'hub-pins' });
    cloud = createTestApp(cloudDb);
    hubUser = randomUUID();
    await cloudDb.query('insert into auth.users (id) values ($1)', [hubUser]);
    const [{ id: hubDeviceId }] = (await cloudDb.query<{ id: string }>(
      `insert into devices (restaurant_id, branch_id, kind, name, auth_user_id) values ($1, $2, 'hub', 'HUB-01', $3) returning id`,
      [f.restaurantId, f.branchId, hubUser],
    )) as [{ id: string }];
    const owner = await cloud.as(f.authUsers.manager);
    await cloud.app.setBranchHub.execute(owner, f.branchId, { hubDeviceId });
    [{ id: cashierStaff }] = (await cloudDb.query<{ id: string }>('select id from staff where user_id = $1', [
      f.authUsers.cashier,
    ])) as [{ id: string }];
    // The owner gives the cashier a first PIN in the back office.
    await cloud.app.assignStaffPin.execute(owner, cashierStaff, '4827');

    const local = await openLocalDatabase({
      dataDir: null,
      migrationsDir: MIGRATIONS_DIR,
      pglite: await createPgliteInstance(),
    });
    hubDb = local.db;
    hub = createTestApp(hubDb, { pinPepper: HUB_PEPPER });
    const hubCtx = () => cloud.as(hubUser);
    engine = new SyncEngine(
      hubDb,
      {
        snapshot: async (since) => {
          if (!online) throw offline();
          return cloud.app.getHubSnapshot.execute(await hubCtx(), since);
        },
        upload: async (batch) => {
          if (!online) throw offline();
          return cloud.app.ingestHubBatch.execute(await hubCtx(), batch);
        },
      },
      { newId: randomUUID },
    );
    await engine.init();
    await engine.syncOnce();
    pins = new HubPinService(
      hubDb,
      hub.app,
      new HmacPinHasher(HUB_PEPPER),
      {
        verifyPin: async (pin) => {
          if (!online) throw offline();
          return cloud.app.verifyPinForHub.execute(await hubCtx(), pin);
        },
        changePin: async (cmd) => {
          if (!online) throw offline();
          return cloud.app.changePinFromHub.execute(await hubCtx(), cmd);
        },
      },
      () => online,
    );
  });
  afterAll(async () => {
    await hubDb?.close();
    await cloudDb?.close();
  });

  const tillCtx = async () => {
    // The till's own device login on the hub.
    const [d] = await hubDb.query<{ auth_user_id: string | null }>(
      'select auth_user_id from devices where id = $1',
      [f.devices.pos],
    );
    if (!d?.auth_user_id) {
      const id = randomUUID();
      await hubDb.query('insert into auth.users (id) values ($1)', [id]);
      await hubDb.query('update devices set auth_user_id = $2 where id = $1', [f.devices.pos, id]);
      return hub.as(id);
    }
    return hub.as(d.auth_user_id);
  };

  const hubDigests = () =>
    hubDb.query<{ id: string; pin_lookup: string | null }>(
      'select id, pin_lookup from staff where pin_lookup is not null',
    );

  it('first sign-in needs the cloud; the hub then keeps its own digest, never the cloud one', async () => {
    online = false;
    await expect(pins.signIn(await tillCtx(), '4827')).rejects.toMatchObject({ code: 'PIN_INVALID' });

    online = true;
    const r = await pins.signIn(await tillCtx(), '4827');
    expect(r.mustChangePin).toBe(true);
    const [cloudDigest] = await cloudDb.query<{ pin_lookup: string }>(
      'select pin_lookup from staff where id = $1',
      [cashierStaff],
    );
    const digests = await hubDigests();
    expect(digests.map((d) => d.id)).toEqual([cashierStaff]);
    expect(digests[0]!.pin_lookup).not.toBe(cloudDigest!.pin_lookup);
  });

  it('changing the PIN on a hub till goes to the cloud; the new PIN then works offline', async () => {
    const staffCtx = { ...(await hub.as(f.authUsers.cashier, f.devices.pos)), authMethod: 'pin' as const };
    await pins.changeOwnPin(staffCtx, { newPin: '5938' });
    // Works in the cloud too (e.g. on the web POS).
    const cloudCheck = await cloud.app.verifyPinForHub.execute(await cloud.as(hubUser), '5938');
    expect(cloudCheck.staffId).toBe(cashierStaff);

    await engine.syncOnce(); // the hub's copy survives the next snapshot (same pin_set_at)
    online = false;
    const r = await pins.signIn(await tillCtx(), '5938');
    expect(r.mustChangePin).toBe(false);
    await expect(pins.signIn(await tillCtx(), '4827')).rejects.toMatchObject({ code: 'PIN_INVALID' });

    // Offline, a signed-in cashier can sell; the sale is attributed to them.
    const cashier = await hub.as(f.authUsers.cashier, f.devices.pos);
    const order = await hub.app.submitOrder.execute(cashier, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(f.products.coke, 1)],
      send: { submissionId: uuid() },
    });
    expect(order.id).toBeDefined();
    online = true;
  });

  it('changing a PIN offline is refused with a clear message; the current PIN keeps working', async () => {
    online = false;
    const staffCtx = await hub.as(f.authUsers.cashier, f.devices.pos);
    await expect(pins.changeOwnPin(staffCtx, { currentPin: '5938', newPin: '7261' })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    await expect(pins.signIn(await tillCtx(), '5938')).resolves.toBeDefined();
    online = true;
  });

  it('wrong PINs offline lock the till, and the lockout is recorded', async () => {
    online = false;
    // Earlier failures in this window count too: the till locks within five wrong PINs.
    let locked = false;
    for (let i = 0; i < 5 && !locked; i++)
      locked = await pins.signIn(await tillCtx(), '1357').then(
        () => false,
        (e: { code?: string }) => e.code === 'RATE_LIMITED',
      );
    await expect(pins.signIn(await tillCtx(), '5938')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const [audit] = await hubDb.query<{ n: number }>(
      `select count(*)::int as n from audit_logs where action = 'security.pin_lockout'`,
    );
    expect(audit!.n).toBeGreaterThan(0);
    hub.clock.advance(11 * 60);
    await expect(pins.signIn(await tillCtx(), '5938')).resolves.toBeDefined();
    online = true;
  });

  it('a PIN reset in the back office stops the old PIN on the hub after the next sync', async () => {
    await cloud.app.assignStaffPin.execute(await cloud.as(f.authUsers.manager), cashierStaff, '6049');
    await engine.syncOnce();
    expect(await hubDigests()).toEqual([]);
    online = false;
    await expect(pins.signIn(await tillCtx(), '5938')).rejects.toMatchObject({ code: 'PIN_INVALID' });
    online = true;
    await expect(pins.signIn(await tillCtx(), '6049')).resolves.toMatchObject({ mustChangePin: true });
  });

  it('a staff member deactivated in the back office cannot sign in on the hub after the next sync', async () => {
    await cloudDb.query('update staff set is_active = false where id = $1', [cashierStaff]);
    await engine.syncOnce();
    online = false;
    await expect(pins.signIn(await tillCtx(), '6049')).rejects.toMatchObject({ code: 'PIN_INVALID' });
    online = true;
    await cloudDb.query('update staff set is_active = true where id = $1', [cashierStaff]);
  });

  it('everything the hub recorded (sign-ins, lockouts, sales) reaches the cloud without conflicts', async () => {
    await engine.syncOnce();
    const status = await engine.status();
    expect(status.outbox.conflictList).toEqual([]);
    expect(status.outbox.pending).toBe(0);
    const [{ n }] = (await cloudDb.query<{ n: number }>(
      `select count(*)::int as n from audit_logs where origin_id is not null and action = 'staff.pin_sign_in'`,
    )) as [{ n: number }];
    expect(n).toBeGreaterThan(0);
  });

  it('PIN checks through the cloud are for hubs only', async () => {
    await expect(
      cloud.app.verifyPinForHub.execute(await cloud.as(f.authUsers.manager), '6049'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      cloud.app.changePinFromHub.execute(await cloud.as(f.authUsers.agent), {
        staffId: cashierStaff,
        newPin: '8163',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
