import { randomUUID } from 'node:crypto';
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
 * Production, 2026-09-30: a hub that ran its branch was revoked; the branch stayed attached to it,
 * so the cloud refused every web POS order and the screens offered no way back. A hub that is
 * revoked or turned off now releases its branch (audited), in the same transaction.
 */
describe('a hub that runs its branch is revoked or turned off', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let app: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'hub-release' });
    app = createTestApp(db);
  });
  afterAll(async () => {
    await db.close();
  });

  /** A paired hub of the branch (has a login), attached so that it runs the branch. */
  async function attachedHub(name: string): Promise<string> {
    const login = randomUUID();
    await db.query('insert into auth.users (id) values ($1)', [login]);
    const [{ id }] = (await db.query<{ id: string }>(
      `insert into devices (restaurant_id, branch_id, kind, name, auth_user_id) values ($1, $2, 'hub', $3, $4) returning id`,
      [f.restaurantId, f.branchId, name, login],
    )) as [{ id: string }];
    await app.app.setBranchHub.execute(await app.as(f.authUsers.manager), f.branchId, { hubDeviceId: id });
    return id;
  }
  const webOrder = async () =>
    app.app.submitOrder.execute(await app.as(f.authUsers.cashier, f.devices.pos), {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(f.products.coke, 1)],
    });
  const branchHub = async () =>
    (
      (await db.query<{ hub: string | null }>('select hub_device_id as hub from branches where id = $1', [
        f.branchId,
      ])) as [{ hub: string | null }]
    )[0].hub;

  it('revoked: the branch goes back to the web POS, audited with the reason', async () => {
    const hub = await attachedHub('HUB-A');
    await expect(webOrder()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'branch_run_by_hub' },
    });
    await app.app.revokeDevice.execute(await app.as(f.authUsers.manager), hub);
    expect(await branchHub()).toBeNull();
    const order = await webOrder();
    expect(order.orderNumber).toBeGreaterThan(0);
    await app.app.cancelOrder.execute(await app.as(f.authUsers.manager), order.id, { reason: 'Test' });
    const [audit] = (await db.query<{ reason: string; before_data: { hubDeviceId: string } }>(
      `select reason, before_data from audit_logs where action = 'branch.hub_detached' order by id desc limit 1`,
    )) as [{ reason: string; before_data: { hubDeviceId: string } }];
    expect(audit.reason).toBe('The hub was revoked');
    expect(audit.before_data.hubDeviceId).toBe(hub);
  });

  it('turned off: the branch goes back to the web POS', async () => {
    const hub = await attachedHub('HUB-B');
    await app.app.saveConfig.execute(await app.as(f.authUsers.manager), 'device', {
      id: hub,
      branchId: f.branchId,
      kind: 'hub',
      name: 'HUB-B',
      isActive: false,
    });
    expect(await branchHub()).toBeNull();
    const order = await webOrder();
    await app.app.cancelOrder.execute(await app.as(f.authUsers.manager), order.id, { reason: 'Test' });
  });

  it('revoking a hub that does NOT run the branch leaves the branch with its own hub', async () => {
    const running = await attachedHub('HUB-C');
    const login = randomUUID();
    await db.query('insert into auth.users (id) values ($1)', [login]);
    const [{ id: spare }] = (await db.query<{ id: string }>(
      `insert into devices (restaurant_id, branch_id, kind, name, auth_user_id) values ($1, $2, 'hub', 'HUB-SPARE', $3) returning id`,
      [f.restaurantId, f.branchId, login],
    )) as [{ id: string }];
    await app.app.revokeDevice.execute(await app.as(f.authUsers.manager), spare);
    expect(await branchHub()).toBe(running);
  });
});
