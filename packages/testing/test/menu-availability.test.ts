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

describe('Menu: description, availability and ingredient stock on the POS', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;
  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'menu-avail' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());
  const owner = () => t.as(f.authUsers.manager);
  const cashier = () => t.as(f.authUsers.cashier, f.devices.pos);
  const posProduct = async (id: string) =>
    (await t.app.getMenu.execute(await cashier(), f.branchId)).products.find((p) => p.id === id)!;
  const sell = async (productId: string) =>
    t.app.submitOrder.execute(await cashier(), {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      customerName: 'Ama',
      items: [line(productId, 1)],
      send: { submissionId: uuid() },
    });

  it('a product description is saved and reaches the POS', async () => {
    const product = (
      await db.query<Record<string, unknown>>('select * from products where id = $1', [f.products.chicken])
    )[0]!;
    await t.app.saveConfig.execute(await owner(), 'product', {
      id: f.products.chicken,
      name: 'Grilled Chicken',
      description: 'Quarter chicken with pepper sauce',
      categoryId: product.category_id,
      basePrice: 6000,
      isActive: true,
      taxRateIds: [f.taxRateId],
    });
    expect((await posProduct(f.products.chicken)).description).toBe('Quarter chicken with pepper sauce');
  });

  it('low or out-of-stock ingredients are flagged but never block a sale', async () => {
    const m = await owner();
    const item = async (name: string) =>
      (
        await t.app.saveInventoryItem.execute(m, {
          branchId: f.branchId,
          name,
          unit: 'kg',
          minQuantity: 2,
          unitCost: 100,
          isActive: true,
        })
      ).id;
    const rice = await item('Rice');
    const oil = await item('Oil');
    await t.app.recordStockMovement.execute(m, {
      movementId: uuid(),
      itemId: rice,
      kind: 'receive',
      quantity: 10,
    });
    await t.app.recordStockMovement.execute(m, {
      movementId: uuid(),
      itemId: oil,
      kind: 'receive',
      quantity: 1,
    });
    await t.app.saveRecipe.execute(m, f.products.jollof, {
      components: [
        { itemId: rice, quantity: 0.25 },
        { itemId: oil, quantity: 0.5 },
      ],
    });
    expect((await posProduct(f.products.jollof)).ingredients).toEqual({ state: 'low', items: ['Oil'] });
    expect((await posProduct(f.products.coke)).ingredients).toBeNull(); // no recipe
    await sell(f.products.jollof); // oil 1 -> 0.5 (still low)
    await sell(f.products.jollof); // oil 0.5 -> 0: out
    const jollof = await posProduct(f.products.jollof);
    expect(jollof.ingredients).toEqual({ state: 'out', items: ['Oil'] });
    expect(jollof.isAvailable).toBe(true);
    // Still sellable: the restaurant decides when to mark it sold out.
    await expect(sell(f.products.jollof)).resolves.toMatchObject({ status: expect.any(String) });
  });

  it('a product marked sold out cannot be sold', async () => {
    await t.app.saveConfig.execute(await owner(), 'branchProduct', {
      branchId: f.branchId,
      productId: f.products.meatPie,
      isAvailable: false,
    });
    expect((await posProduct(f.products.meatPie)).isAvailable).toBe(false);
    await expect(sell(f.products.meatPie)).rejects.toMatchObject({ code: 'PRODUCT_UNAVAILABLE' });
  });
});
