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

describe('Inventory, stock movements, stock taking, recipes', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let other: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'stock' });
    other = await seedRestaurant(db, { slug: 'stock-other' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());

  const item = async (name: string, unit = 'kg', min = 5) => {
    const manager = await t.as(f.authUsers.manager);
    const { id } = await t.app.saveInventoryItem.execute(manager, {
      branchId: f.branchId,
      name,
      unit: unit as 'kg',
      minQuantity: min,
      unitCost: 2500,
      isActive: true,
    });
    return id;
  };
  const stockOf = async (id: string) =>
    (await t.app.listInventory.execute(await t.as(f.authUsers.manager), f.branchId)).items.find(
      (i) => i.id === id,
    )!;

  it('stock only changes through audited movements; deliveries, wastage and adjustments; idempotent', async () => {
    const manager = await t.as(f.authUsers.manager);
    const rice = await item('Rice');
    expect((await stockOf(rice)).quantity).toBe(0);
    expect((await stockOf(rice)).isLow).toBe(true);

    const delivery = {
      movementId: uuid(),
      itemId: rice,
      kind: 'receive' as const,
      quantity: 25.5,
      reference: 'INV-204',
    };
    expect((await t.app.recordStockMovement.execute(manager, delivery)).quantity).toBe(25.5);
    expect((await t.app.recordStockMovement.execute(manager, delivery)).quantity).toBe(25.5); // retry: once
    await t.app.recordStockMovement.execute(manager, {
      movementId: uuid(),
      itemId: rice,
      kind: 'waste',
      quantity: 1.25,
      reason: 'Bag torn',
    });
    const r = await stockOf(rice);
    expect(r.quantity).toBe(24.25);
    expect(r.value).toBe(Math.round(24.25 * 2500));
    expect(r.isLow).toBe(false);

    await expect(
      t.app.recordStockMovement.execute(manager, {
        movementId: uuid(),
        itemId: rice,
        kind: 'waste',
        quantity: 1,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: 'Say why the stock was wasted' });
    await expect(
      t.app.recordStockMovement.execute(manager, {
        movementId: uuid(),
        itemId: rice,
        kind: 'waste',
        quantity: 100,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: 'Only 24.25 in stock' });

    const history = await t.app.listStockMovements.execute(manager, f.branchId, rice);
    expect(history.map((m) => [m.kind, m.quantityDelta, m.quantityAfter])).toEqual([
      ['waste', -1.25, 24.25],
      ['receive', 25.5, 25.5],
    ]);
    const audit = await db.query<{ action: string }>(
      `select action from audit_logs where entity_id = $1 order by id`,
      [rice],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'inventory.item_create',
      'inventory.receive',
      'inventory.waste',
    ]);

    // Editing item details never touches the quantity.
    await t.app.saveInventoryItem.execute(manager, {
      id: rice,
      branchId: f.branchId,
      name: 'Rice (jasmine)',
      unit: 'kg',
      minQuantity: 30,
      unitCost: 2500,
      isActive: true,
    });
    expect(await stockOf(rice)).toMatchObject({ name: 'Rice (jasmine)', quantity: 24.25, isLow: true });

    // Ledger is append-only for the API role.
    await expect(
      db.transaction(async (sql) => {
        await sql.query(`select set_config('app.restaurant_id', $1, true)`, [f.restaurantId]);
        await sql.query('set local role app_api');
        await sql.query('delete from stock_movements where item_id = $1', [rice]);
      }),
    ).rejects.toBeTruthy();
  });

  it('cashiers cannot manage stock; another restaurant cannot see it', async () => {
    const rice = await item('Oil', 'l');
    await expect(
      t.app.recordStockMovement.execute(await t.as(f.authUsers.cashier), {
        movementId: uuid(),
        itemId: rice,
        kind: 'receive',
        quantity: 1,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      t.app.listInventory.execute(await t.as(f.authUsers.cashier), f.branchId),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      t.app.recordStockMovement.execute(await t.as(other.authUsers.manager), {
        movementId: uuid(),
        itemId: rice,
        kind: 'receive',
        quantity: 1,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('stock take: count, submit, approve; variances need reasons and are applied against current stock', async () => {
    const manager = await t.as(f.authUsers.manager);
    const chicken = await item('Chicken breast');
    const tomato = await item('Tomatoes');
    for (const [id, q] of [
      [chicken, 24],
      [tomato, 10],
    ] as const)
      await t.app.recordStockMovement.execute(manager, {
        movementId: uuid(),
        itemId: id,
        kind: 'receive',
        quantity: q,
      });

    const countId = uuid();
    await t.app.startStockCount.execute(manager, {
      countId,
      branchId: f.branchId,
      note: 'Weekly count',
      itemIds: [chicken, tomato],
    });
    await t.app.startStockCount.execute(manager, { countId, branchId: f.branchId }); // retry
    await t.app.recordCountLine.execute(manager, countId, { itemId: chicken, countedQuantity: 21.5 });
    await t.app.recordCountLine.execute(manager, countId, { itemId: tomato, countedQuantity: 10 });
    let count = await t.app.getStockCount.execute(manager, countId);
    expect(count.items.find((i) => i.itemId === chicken)).toMatchObject({
      systemQuantity: 24,
      countedQuantity: 21.5,
      variance: -2.5,
      varianceValue: -6250,
    });
    expect(count).toMatchObject({ status: 'open', lines: 2, counted: 2, variances: 1 });
    // Counting changes nothing yet.
    expect((await stockOf(chicken)).quantity).toBe(24);

    await t.app.submitStockCount.execute(manager, countId, { expectedVersion: count.version });
    await expect(
      t.app.recordCountLine.execute(manager, countId, { itemId: chicken, countedQuantity: 1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    count = await t.app.getStockCount.execute(manager, countId);
    // The variance needs a reason before it can be applied.
    await expect(
      t.app.approveStockCount.execute(manager, countId, { expectedVersion: count.version }),
    ).rejects.toMatchObject({ message: 'Every difference needs a reason' });

    // Reopen by cancelling is the only way to change a submitted count: start a new one with reasons.
    await t.app.cancelStockCount.execute(manager, countId, { expectedVersion: count.version });
    const second = uuid();
    await t.app.startStockCount.execute(manager, {
      countId: second,
      branchId: f.branchId,
      itemIds: [chicken],
    });
    await t.app.recordCountLine.execute(manager, second, {
      itemId: chicken,
      countedQuantity: 21.5,
      reason: 'Usage not recorded',
    });
    // Stock moves while the count is in progress: approval compares with CURRENT stock.
    await t.app.recordStockMovement.execute(manager, {
      movementId: uuid(),
      itemId: chicken,
      kind: 'receive',
      quantity: 2,
    });
    let c2 = await t.app.getStockCount.execute(manager, second);
    await t.app.submitStockCount.execute(manager, second, { expectedVersion: c2.version });
    c2 = await t.app.getStockCount.execute(manager, second);
    await expect(
      t.app.approveStockCount.execute(await t.as(f.authUsers.cashier), second, {
        expectedVersion: c2.version,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      (await t.app.approveStockCount.execute(manager, second, { expectedVersion: c2.version })).adjusted,
    ).toBe(1);
    expect((await stockOf(chicken)).quantity).toBe(21.5);
    const moves = await t.app.listStockMovements.execute(manager, f.branchId, chicken);
    expect(moves[0]).toMatchObject({
      kind: 'count',
      quantityDelta: -4.5,
      quantityAfter: 21.5,
      reason: 'Usage not recorded',
    });
    expect((await t.app.getStockCount.execute(manager, second)).status).toBe('approved');
    const audit = await db.query<{ action: string }>(
      `select action from audit_logs where entity_id in ($1, $2) order by id`,
      [countId, second],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'stock_count.start',
      'stock_count.submit',
      'stock_count.cancel',
      'stock_count.start',
      'stock_count.submit',
      'stock_count.approve',
    ]);
  });

  it('sales deduct stock only for products with a recipe, in the same transaction as the order', async () => {
    const manager = await t.as(f.authUsers.manager);
    const rice = await item('Parboiled rice');
    const oil = await item('Vegetable oil', 'l', 1);
    await t.app.recordStockMovement.execute(manager, {
      movementId: uuid(),
      itemId: rice,
      kind: 'receive',
      quantity: 10,
    });
    await t.app.recordStockMovement.execute(manager, {
      movementId: uuid(),
      itemId: oil,
      kind: 'receive',
      quantity: 5,
    });
    await t.app.saveRecipe.execute(manager, f.products.jollof, {
      components: [
        { itemId: rice, quantity: 0.25 },
        { itemId: oil, quantity: 0.05 },
      ],
    });
    expect((await t.app.getRecipe.execute(manager, f.products.jollof)).map((c) => c.quantity).sort()).toEqual(
      [0.05, 0.25],
    );

    const order = await t.app.submitOrder.execute(await t.as(f.authUsers.cashier, f.devices.pos), {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(f.products.jollof, 3), line(f.products.coke, 2)],
      send: { submissionId: uuid() },
    });
    expect((await stockOf(rice)).quantity).toBe(9.25);
    expect((await stockOf(oil)).quantity).toBe(4.85);
    const sale = (await t.app.listStockMovements.execute(manager, f.branchId, rice))[0]!;
    expect(sale).toMatchObject({
      kind: 'sale',
      quantityDelta: -0.75,
      reference: `Order #${order.orderNumber}`,
    });
    expect((await stockOf(rice)).usedIn).toContain('Jollof Rice');

    // Recipes are menu configuration: cashiers cannot change them.
    await expect(
      t.app.saveRecipe.execute(await t.as(f.authUsers.cashier), f.products.jollof, { components: [] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
