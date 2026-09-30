import { ROLE_TEMPLATES } from '@rp/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestDatabase,
  type RestaurantFixture,
  seedRestaurant,
  type TestApp,
  type TestDatabase,
} from '../src';
import { uuid } from './helpers';

/**
 * Managers manage staff (owner's decision, 2026-09-30), but owners stay protected: only an Owner
 * may give the Owner role, change the Owner role, or change, reset or deactivate an Owner.
 */
describe('managers manage staff; owners are protected', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;
  let ownerRole: string;
  let waiterRole: string;
  let ownerStaff: string;
  let managerCtx: Awaited<ReturnType<TestApp['as']>>;
  let managerStaff: string;

  const one = async (sql: string, params: unknown[]) =>
    ((await db.query<{ id: string }>(sql, params)) as [{ id: string }])[0].id;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'owner-protection' });
    t = createTestApp(db);
    const managerRole = await one(
      `insert into roles (restaurant_id, name, is_system) values ($1, 'Manager', true) returning id`,
      [f.restaurantId],
    );
    for (const p of ROLE_TEMPLATES.Manager!)
      await db.query(
        'insert into role_permissions (restaurant_id, role_id, permission_code) values ($1, $2, $3)',
        [f.restaurantId, managerRole, p],
      );
    ownerRole = await one(`select id from roles where name = 'Owner'`, []);
    waiterRole = await one(`select id from roles where name = 'Waiter'`, []);
    ownerStaff = await one('select id from staff where user_id = $1', [f.authUsers.manager]);
    const owner = await t.as(f.authUsers.manager);
    ({ staffId: managerStaff } = await t.app.createStaff.execute(owner, {
      displayName: 'Ayensu',
      email: `manager-${uuid().slice(0, 8)}@fixtures.example.com`,
      password: 'correct-horse-battery',
      roleIds: [managerRole],
    }));
    managerCtx = await t.as(await one('select user_id as id from staff where id = $1', [managerStaff]));
  });
  afterAll(async () => {
    await db.close();
  });

  const refused = { code: 'FORBIDDEN', details: { reason: 'owner_protected' } };

  it('a manager adds a waiter, gives a starting PIN and deactivates them', async () => {
    const { staffId } = await t.app.createStaff.execute(managerCtx, {
      displayName: 'Ama',
      email: `waiter-${uuid().slice(0, 8)}@fixtures.example.com`,
      pin: '7391',
      roleIds: [waiterRole],
      branchId: f.branchId,
    });
    await t.app.assignStaffPin.execute(managerCtx, staffId, '8264');
    await t.app.updateStaff.execute(managerCtx, staffId, { isActive: false });
  });

  it('a manager cannot create an owner, or make anyone an owner', async () => {
    await expect(
      t.app.createStaff.execute(managerCtx, {
        displayName: 'New owner',
        email: `x-${uuid().slice(0, 8)}@fixtures.example.com`,
        password: 'correct-horse-battery',
        roleIds: [ownerRole],
      }),
    ).rejects.toMatchObject(refused);
    const { staffId } = await t.app.createStaff.execute(managerCtx, {
      displayName: 'Kofi',
      email: `kofi-${uuid().slice(0, 8)}@fixtures.example.com`,
      password: 'correct-horse-battery',
      roleIds: [waiterRole],
    });
    await expect(
      t.app.updateStaff.execute(managerCtx, staffId, { roleIds: [ownerRole] }),
    ).rejects.toMatchObject(refused);
  });

  it('a manager cannot deactivate, rename, re-role, re-password or reset the PIN of an owner', async () => {
    await expect(
      t.app.updateStaff.execute(managerCtx, ownerStaff, { isActive: false }),
    ).rejects.toMatchObject(refused);
    await expect(
      t.app.updateStaff.execute(managerCtx, ownerStaff, { password: 'taken-over-password' }),
    ).rejects.toMatchObject(refused);
    await expect(
      t.app.updateStaff.execute(managerCtx, ownerStaff, { roleIds: [waiterRole] }),
    ).rejects.toMatchObject(refused);
    await expect(t.app.assignStaffPin.execute(managerCtx, ownerStaff, '5917')).rejects.toMatchObject(refused);
  });

  it('a manager cannot change the Owner role itself', async () => {
    await expect(
      t.app.saveConfig.execute(managerCtx, 'role', { id: ownerRole, name: 'Owner', permissions: [] }),
    ).rejects.toMatchObject(refused);
  });

  it('an owner can still do all of it', async () => {
    const owner = await t.as(f.authUsers.manager);
    await t.app.assignStaffPin.execute(owner, managerStaff, '6482');
    await t.app.updateStaff.execute(owner, managerStaff, { displayName: 'Ayensu M.' });
  });
});
