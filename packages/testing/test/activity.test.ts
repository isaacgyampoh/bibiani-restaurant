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

describe('Activity (audit history)', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;
  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'activity' });
    t = createTestApp(db);
    const owner = await t.as(f.authUsers.manager);
    // A price change, a promotion and a PIN assignment.
    const product = (
      await db.query<Record<string, unknown>>('select * from products where id = $1', [f.products.jollof])
    )[0]!;
    await t.app.saveConfig.execute(owner, 'product', {
      id: f.products.jollof,
      name: 'Jollof Rice',
      categoryId: product.category_id,
      basePrice: 5000,
      isActive: true,
      taxRateIds: [f.taxRateId],
    });
    await t.app.savePromotion.execute(owner, {
      name: 'Lunch Promotion',
      kind: 'fixed_price',
      amount: 4000,
      appliesToAll: false,
      productIds: [f.products.jollof],
      categoryIds: [],
      daysOfWeek: [1, 2, 3, 4, 5],
      startTime: '12:00',
      endTime: '15:00',
      priority: 0,
      status: 'active',
    });
    const kofi = (
      await db.query<{ id: string }>('select id from staff where user_id = $1', [f.authUsers.cashier])
    )[0]!.id;
    await t.app.assignStaffPin.execute(owner, kofi, '6284');
  });
  afterAll(() => db.close());

  it('owners see who changed what, newest first, with the name of what changed', async () => {
    const view = await t.app.listActivity.execute(await t.as(f.authUsers.manager), {});
    expect(view.entries.map((e) => e.action)).toEqual([
      'staff.pin_assigned',
      'promotion.create',
      'config.product.update',
    ]);
    expect(view.entries[1]).toMatchObject({ actor: 'Ama Owner', entityLabel: 'Lunch Promotion' });
    expect(view.entries[2]).toMatchObject({ entityLabel: 'Jollof Rice' });
    expect(view.entries[2]!.before).toMatchObject({ base_price: 4500 });
    expect(view.entries[2]!.after).toMatchObject({ basePrice: 5000 });
    expect(view.nextBefore).toBeNull();
  });

  it('filters by area and searches by name; never shows a PIN', async () => {
    const owner = await t.as(f.authUsers.manager);
    expect(
      (await t.app.listActivity.execute(owner, { category: 'promotions' })).entries.map((e) => e.action),
    ).toEqual(['promotion.create']);
    expect(
      (await t.app.listActivity.execute(owner, { category: 'menu' })).entries.map((e) => e.action),
    ).toEqual(['config.product.update']);
    expect((await t.app.listActivity.execute(owner, { category: 'staff' })).entries).toHaveLength(1);
    expect(
      (await t.app.listActivity.execute(owner, { search: 'jollof' })).entries.map((e) => e.action),
    ).toEqual(['config.product.update']);
    // "%" and "_" are searched literally, not as wildcards.
    expect((await t.app.listActivity.execute(owner, { search: '%' })).entries).toHaveLength(0);
    const all = JSON.stringify(await t.app.listActivity.execute(owner, {}));
    expect(all).not.toContain('6284');
    expect(all).not.toMatch(/pin_lookup|pinLookup/);
  });

  it('pages through long histories', async () => {
    const owner = await t.as(f.authUsers.manager);
    for (let i = 0; i < 65; i++)
      await t.app.recordStockMovement
        .execute(owner, { movementId: randomUUID(), itemId: await item(), kind: 'receive', quantity: 1 })
        .catch(() => undefined);
    const first = await t.app.listActivity.execute(owner, { category: 'inventory' });
    expect(first.entries).toHaveLength(60);
    expect(first.nextBefore).not.toBeNull();
    const second = await t.app.listActivity.execute(owner, {
      category: 'inventory',
      before: first.nextBefore,
    });
    expect(second.entries.length).toBeGreaterThan(0);
    expect(second.entries[0]!.id).toBeLessThan(first.entries.at(-1)!.id);
  });

  it('cashiers and supervisors cannot read the history', async () => {
    await expect(
      t.app.listActivity.execute(await t.as(f.authUsers.cashier, f.devices.pos), {}),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  let itemId: string | null = null;
  async function item() {
    if (!itemId)
      itemId = (
        await t.app.saveInventoryItem.execute(await t.as(f.authUsers.manager), {
          branchId: f.branchId,
          name: 'Rice',
          unit: 'kg',
          minQuantity: 1,
          unitCost: 1000,
          isActive: true,
        })
      ).id;
    return itemId;
  }
});
