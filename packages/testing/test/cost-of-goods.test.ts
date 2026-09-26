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

describe('Cost of goods from recipes', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;
  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'cogs' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());

  it('each sale records the ingredient cost at that time; the report totals it and never guesses the rest', async () => {
    const m = await t.as(f.authUsers.manager);
    const cashier = await t.as(f.authUsers.cashier, f.devices.pos);
    // Rice at GHS 12.00 per kg; one Jollof uses 0.25 kg -> GHS 3.00 of rice.
    const { id: rice } = await t.app.saveInventoryItem.execute(m, {
      branchId: f.branchId,
      name: 'Rice',
      unit: 'kg',
      minQuantity: 1,
      unitCost: 1200,
      isActive: true,
    });
    await t.app.recordStockMovement.execute(m, {
      movementId: uuid(),
      itemId: rice,
      kind: 'receive',
      quantity: 20,
    });
    await t.app.saveRecipe.execute(m, f.products.jollof, { components: [{ itemId: rice, quantity: 0.25 }] });
    const sell = (items: ReturnType<typeof line>[]) =>
      t.app.submitOrder.execute(cashier, {
        orderId: uuid(),
        branchId: f.branchId,
        areaId: f.areas.takeaway,
        customerName: 'Ama',
        items,
        send: { submissionId: uuid() },
      });
    await sell([line(f.products.jollof, 2), line(f.products.coke, 1)]); // rice cost 2 x 3.00
    // The rice price goes up: later sales use the new cost, earlier ones keep theirs.
    await t.app.saveInventoryItem.execute(m, {
      id: rice,
      branchId: f.branchId,
      name: 'Rice',
      unit: 'kg',
      minQuantity: 1,
      unitCost: 1600,
      isActive: true,
    });
    await sell([line(f.products.jollof, 1)]); // 0.25 x 16.00 = 4.00
    const cancelled = await sell([line(f.products.jollof, 4)]);
    await t.app.cancelOrder.execute(m, cancelled.id, { reason: 'Customer left' });

    const ledger = await t.app.listStockMovements.execute(m, f.branchId, rice);
    expect(ledger.filter((x) => x.kind === 'sale').map((x) => x.unitCost)).toEqual([1600, 1600, 1200]);

    const report = await t.app.getSalesReport.execute(m, f.branchId, '2026-09-25', '2026-09-25');
    expect(report.totals.cost).toEqual({
      ingredients: 600 + 400, // the cancelled order is not a sale
      salesWithRecipes: 3 * 4500,
      salesWithoutRecipes: 1000, // the Coke: no recipe, no cost recorded, shown separately
      uncostedUses: 0,
    });
  });
});
