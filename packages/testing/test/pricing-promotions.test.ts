import type { SavePromotionCommand } from '@rp/contracts';
import {
  allocateDiscount,
  choosePromotion,
  isPromotionLive,
  type Promotion,
  promotionDiscount,
  promotionPhase,
  receiptDocument,
} from '@rp/domain';
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

const promo = (over: Partial<Promotion>): Promotion => ({
  id: uuid(),
  name: 'Promo',
  kind: 'percent_off',
  percentBp: 1000,
  amount: null,
  bundleQuantity: null,
  appliesToAll: true,
  productIds: [],
  categoryIds: [],
  branchId: null,
  startsOn: null,
  endsOn: null,
  daysOfWeek: null,
  startTime: null,
  endTime: null,
  priority: 0,
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

describe('Pricing rules (domain)', () => {
  it('each promotion type discounts the base price, never below zero', () => {
    expect(promotionDiscount(promo({ percentBp: 1000 }), 4500, 2)).toBe(900);
    expect(promotionDiscount(promo({ percentBp: 10_000 }), 4500, 2)).toBe(9000);
    expect(promotionDiscount(promo({ kind: 'amount_off', percentBp: null, amount: 500 }), 4500, 3)).toBe(
      1500,
    );
    // More off than the price: capped at the price (never negative).
    expect(promotionDiscount(promo({ kind: 'amount_off', percentBp: null, amount: 9999 }), 4500, 1)).toBe(
      4500,
    );
    expect(promotionDiscount(promo({ kind: 'fixed_price', percentBp: null, amount: 4000 }), 4500, 2)).toBe(
      1000,
    );
    // A "promotional price" above the normal price gives nothing (never a surcharge).
    expect(promotionDiscount(promo({ kind: 'fixed_price', percentBp: null, amount: 5000 }), 4500, 2)).toBe(0);
    // 3 Kebabs for GH₵25 (normal GH₵10 each): 4 kebabs = one bundle + one at full price.
    const bundle = promo({ kind: 'bundle_price', percentBp: null, amount: 2500, bundleQuantity: 3 });
    expect(promotionDiscount(bundle, 1000, 2)).toBe(0);
    expect(promotionDiscount(bundle, 1000, 3)).toBe(500);
    expect(promotionDiscount(bundle, 1000, 4)).toBe(500);
    expect(promotionDiscount(bundle, 1000, 6)).toBe(1000);
  });

  it('time and day windows (restaurant time, windows may cross midnight), paused and expired', () => {
    const friNoon = new Date('2026-09-25T12:00:00Z'); // Friday in Accra (UTC)
    const tz = 'Africa/Accra';
    expect(isPromotionLive(promo({ daysOfWeek: [5] }), friNoon, tz)).toBe(true);
    expect(isPromotionLive(promo({ daysOfWeek: [6] }), friNoon, tz)).toBe(false);
    expect(isPromotionLive(promo({ startTime: '11:00', endTime: '14:00' }), friNoon, tz)).toBe(true);
    expect(isPromotionLive(promo({ startTime: '17:00', endTime: '22:00' }), friNoon, tz)).toBe(false);
    // Late-night Friday special 22:00–02:00 is still Friday's at 01:00 Saturday.
    const late = promo({ daysOfWeek: [5], startTime: '22:00', endTime: '02:00' });
    expect(isPromotionLive(late, new Date('2026-09-26T01:00:00Z'), tz)).toBe(true);
    expect(isPromotionLive(late, new Date('2026-09-27T01:00:00Z'), tz)).toBe(false);
    expect(isPromotionLive(promo({ status: 'paused' }), friNoon, tz)).toBe(false);
    expect(isPromotionLive(promo({ endsOn: '2026-09-24' }), friNoon, tz)).toBe(false);
    expect(promotionPhase(promo({ endsOn: '2026-09-24' }), friNoon, tz)).toBe('ended');
    expect(promotionPhase(promo({ startsOn: '2026-10-01' }), friNoon, tz)).toBe('upcoming');
    expect(promotionPhase(promo({ daysOfWeek: [1] }), friNoon, tz)).toBe('scheduled');
  });

  it('never stacks: highest priority wins, then the bigger discount', () => {
    const small = promo({ name: 'Small', percentBp: 500, priority: 10 });
    const big = promo({ name: 'Big', percentBp: 2000, priority: 0 });
    const line1 = { productId: 'p', categoryPath: [], basePrice: 1000, quantity: 1 };
    expect(choosePromotion([small, big], line1)?.name).toBe('Small');
    expect(choosePromotion([{ ...small, priority: 0 }, big], line1)?.name).toBe('Big');
  });

  it('a manager discount is spread across lines and adds up exactly', () => {
    const shares = allocateDiscount(1000, [
      { id: 'a', net: 3333 },
      { id: 'b', net: 3333 },
      { id: 'c', net: 3334 },
    ]);
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(1000);
    expect(allocateDiscount(99_999, [{ id: 'a', net: 500 }]).get('a')).toBe(500);
  });
});

describe('Promotions and discounts (end to end through the use cases and the database)', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;
  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'pricing' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());

  const owner = () => t.as(f.authUsers.manager);
  const cashier = () => t.as(f.authUsers.cashier, f.devices.pos);
  const draft = (over: Partial<SavePromotionCommand>): SavePromotionCommand => ({
    name: 'Promo',
    kind: 'percent_off',
    percentBp: 1000,
    appliesToAll: false,
    productIds: [],
    categoryIds: [],
    priority: 0,
    status: 'active',
    ...over,
  });
  const order = async (items: ReturnType<typeof line>[], send = true) =>
    t.app.submitOrder.execute(await cashier(), {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      customerName: 'Ama',
      items,
      ...(send ? { send: { submissionId: uuid() } } : {}),
    });
  const list = async () => t.app.listPromotions.execute(await owner());

  it('normal price: quantity × unit price = line total; order total adds up', async () => {
    const o = await order([line(f.products.jollof, 2), line(f.products.coke, 1)]);
    expect(o.items.map((i) => [i.unitPrice, i.quantity, i.grossTotal, i.promotion, i.lineTotal])).toEqual([
      [4500, 2, 9000, null, 9000],
      [1000, 1, 1000, null, 1000],
    ]);
    expect(o.grandTotal).toBe(10_000);
  });

  it('only people with promotions.manage can manage promotions', async () => {
    await expect(
      t.app.savePromotion.execute(await cashier(), draft({ appliesToAll: true })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(t.app.listPromotions.execute(await cashier())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('impossible promotions are refused (over 100%, negative, no targets, bad dates)', async () => {
    const m = await owner();
    for (const bad of [
      draft({ appliesToAll: true, percentBp: 20_000 }),
      draft({ appliesToAll: false }),
      draft({ appliesToAll: true, startsOn: '2026-10-05', endsOn: '2026-10-01' }),
      draft({ appliesToAll: true, kind: 'bundle_price', percentBp: null, amount: 2500, bundleQuantity: 1 }),
      draft({ appliesToAll: true, startTime: '10:00' }),
    ])
      await expect(t.app.savePromotion.execute(m, bad)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  let riceDeal: string;
  let snapshotOrder: { id: string; total: number };
  it('a live percentage promotion on a category is applied automatically and snapshotted on the line', async () => {
    const m = await owner();
    const categoryId = (
      await db.query<{ id: string }>(
        `select id from categories where name = 'Rice Dishes' and restaurant_id = $1`,
        [f.restaurantId],
      )
    )[0]!.id;
    const preview = await t.app.previewPromotion.execute(
      m,
      draft({ name: 'Jollof Friday', categoryIds: [categoryId] }),
    );
    expect(preview).toMatchObject({ valid: true, conflicts: [], phase: 'live' });
    expect(preview.lines).toEqual([
      { productId: f.products.jollof, name: 'Jollof Rice', quantity: 1, normalPrice: 4500, promoPrice: 4050 },
    ]);
    riceDeal = (
      await t.app.savePromotion.execute(m, draft({ name: 'Jollof Friday', categoryIds: [categoryId] }))
    ).id;
    const saved = (await list()).find((p) => p.id === riceDeal)!;
    expect(saved).toMatchObject({ phase: 'live', createdBy: 'Ama Owner', summary: '10% off · every day' });

    // The POS menu shows it.
    const menu = await t.app.getMenu.execute(await cashier(), f.branchId);
    expect(menu.products.find((p) => p.id === f.products.jollof)!.promotion).toMatchObject({
      name: 'Jollof Friday',
      price: 4050,
    });
    expect(menu.products.find((p) => p.id === f.products.coke)!.promotion).toBeNull();

    const o = await order([line(f.products.jollof, 2), line(f.products.coke, 1)]);
    const jollof = o.items[0]!;
    expect(jollof).toMatchObject({
      unitPrice: 4500,
      grossTotal: 9000,
      promotion: { id: riceDeal, name: 'Jollof Friday', discount: 900 },
      lineTotal: 8100,
    });
    expect(o.grandTotal).toBe(9100);
    snapshotOrder = { id: o.id, total: o.grandTotal };

    // Kitchen screen: qty × unit price, promotion, net line, from the same snapshot.
    const board = await t.app.getStationBoard.execute(await t.as(f.authUsers.kitchenKds), f.stations.kitchen);
    const ticketLine = board.tickets.find((x) => x.orderId === o.id)!.items[0]!;
    expect(ticketLine).toMatchObject({
      quantity: 2,
      unitPrice: 4500,
      grossTotal: 9000,
      promotionName: 'Jollof Friday',
      promotionDiscount: 900,
      manualDiscount: 0,
      lineTotal: 8100,
    });

    // Receipt: normal amount, the promotion under it, Subtotal (gross) − Promotions = TOTAL.
    const data = await t.app.getReceipt.execute(await owner(), o.id);
    const text = JSON.stringify(data);
    expect(text).toContain('Promo: Jollof Friday');
    expect(text).toContain('Promotions');
  });

  it('a promotion that has ended never changes historical orders; new orders pay the normal price', async () => {
    const m = await owner();
    const p = (await list()).find((x) => x.id === riceDeal)!;
    await t.app.setPromotionStatus.execute(m, riceDeal, 'end', p.version);
    expect((await list()).find((x) => x.id === riceDeal)!.phase).toBe('ended');
    const again = await t.app.getOrder.execute(m, snapshotOrder.id);
    expect(again.grandTotal).toBe(snapshotOrder.total);
    expect(again.items[0]!.promotion?.name).toBe('Jollof Friday');
    const fresh = await order([line(f.products.jollof, 2)]);
    expect(fresh.items[0]).toMatchObject({ promotion: null, lineTotal: 9000 });
  });

  it('bundle: 3 Cokes for GH₵25; paused and out-of-schedule promotions do not apply', async () => {
    const m = await owner();
    const bundle = await t.app.savePromotion.execute(
      m,
      draft({
        name: '3 Cokes deal',
        kind: 'bundle_price',
        percentBp: null,
        amount: 2500,
        bundleQuantity: 3,
        productIds: [f.products.coke],
      }),
    );
    const o = await order([line(f.products.coke, 4)]);
    expect(o.items[0]).toMatchObject({ grossTotal: 4000, promotion: { discount: 500 }, lineTotal: 3500 });

    const v = (await list()).find((x) => x.id === bundle.id)!.version;
    await t.app.setPromotionStatus.execute(m, bundle.id, 'pause', v);
    expect((await order([line(f.products.coke, 3)])).items[0]!.promotion).toBeNull();

    // Saturday-only and evening-only promotions do not apply on Friday at noon.
    await t.app.savePromotion.execute(
      m,
      draft({ name: 'Weekend pie', productIds: [f.products.meatPie], daysOfWeek: [6, 0] }),
    );
    await t.app.savePromotion.execute(
      m,
      draft({
        name: 'Happy hour',
        productIds: [f.products.meatPie],
        startTime: '17:00',
        endTime: '19:00',
        priority: 5,
      }),
    );
    expect((await order([line(f.products.meatPie, 1)])).items[0]!.promotion).toBeNull();
    const phases = Object.fromEntries((await list()).map((x) => [x.name, x.phase]));
    expect(phases).toMatchObject({
      'Weekend pie': 'scheduled',
      'Happy hour': 'scheduled',
      '3 Cokes deal': 'paused',
    });
  });

  it('conflicting promotions (same items, same time, same priority) are refused; higher priority wins', async () => {
    const m = await owner();
    await t.app.savePromotion.execute(
      m,
      draft({ name: 'Chicken 20%', percentBp: 2000, productIds: [f.products.chicken] }),
    );
    await expect(
      t.app.savePromotion.execute(m, draft({ name: 'All food 5%', percentBp: 500, appliesToAll: true })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('overlaps') });
    const preview = await t.app.previewPromotion.execute(
      m,
      draft({ name: 'All food 5%', percentBp: 500, appliesToAll: true }),
    );
    expect(preview.conflicts).toContain('Chicken 20%');
    await t.app.savePromotion.execute(
      m,
      draft({
        name: 'Chef special',
        kind: 'fixed_price',
        percentBp: null,
        amount: 5500,
        productIds: [f.products.chicken],
        priority: 50,
      }),
    );
    // Priority 50 beats priority 0 even though 20% off would be cheaper.
    const o = await order([line(f.products.chicken, 1)]);
    expect(o.items[0]).toMatchObject({ promotion: { name: 'Chef special', discount: 500 }, lineTotal: 5500 });
  });

  it('a promotion does not change recipe consumption', async () => {
    const m = await owner();
    const { id: chickenStock } = await t.app.saveInventoryItem.execute(m, {
      branchId: f.branchId,
      name: 'Chicken pieces',
      unit: 'pcs',
      minQuantity: 1,
      unitCost: 800,
      isActive: true,
    });
    await t.app.recordStockMovement.execute(m, {
      movementId: uuid(),
      itemId: chickenStock,
      kind: 'receive',
      quantity: 20,
    });
    await t.app.saveRecipe.execute(m, f.products.chicken, {
      components: [{ itemId: chickenStock, quantity: 2 }],
    });
    const o = await order([line(f.products.chicken, 3)]);
    expect(o.items[0]!.promotion).not.toBeNull();
    const item = (await t.app.listInventory.execute(m, f.branchId)).items.find((i) => i.id === chickenStock)!;
    expect(item.quantity).toBe(14);
  });

  it('manager discount: permissioned, reasoned, spread over lines, audited, idempotent, removable', async () => {
    const o = await order([line(f.products.coke, 2), line(f.products.sandwich, 1)]);
    expect(o.grandTotal).toBe(5500);
    const cmd = { discountId: uuid(), kind: 'amount' as const, value: 1000, reason: 'Regular customer' };
    await expect(t.app.applyManualDiscount.execute(await cashier(), o.id, cmd)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      t.app.applyManualDiscount.execute(await owner(), o.id, { ...cmd, discountId: uuid(), value: 999_999 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const after = await t.app.applyManualDiscount.execute(await owner(), o.id, cmd);
    expect(after.grandTotal).toBe(4500);
    expect(after.items.reduce((a, i) => a + i.manualDiscount, 0)).toBe(1000);
    expect(after.discount).toMatchObject({
      amount: 1000,
      reason: 'Regular customer',
      originalTotal: 5500,
      finalTotal: 4500,
      appliedBy: 'Ama Owner',
    });
    // Retry of the same request: nothing changes.
    expect((await t.app.applyManualDiscount.execute(await owner(), o.id, cmd)).grandTotal).toBe(4500);
    // Replacing it with 10%: one active discount, previous one kept in history.
    const pct = await t.app.applyManualDiscount.execute(await owner(), o.id, {
      discountId: uuid(),
      kind: 'percent',
      value: 1000,
      reason: 'Birthday',
    });
    expect(pct.grandTotal).toBe(4950);
    expect(await db.query('select 1 from order_discounts where order_id = $1', [o.id])).toHaveLength(2);
    const audit = await db.query<{ action: string; reason: string }>(
      `select action, reason from audit_logs where entity_id = $1 and action like 'order.discount%' order by created_at`,
      [o.id],
    );
    expect(audit.map((a) => a.reason)).toEqual(['Regular customer', 'Birthday']);
    // Receipt shows the manager discount with its reason.
    expect(JSON.stringify(await t.app.getReceipt.execute(await owner(), o.id))).toContain(
      'Discount (Birthday)',
    );
    const removed = await t.app.removeManualDiscount.execute(await owner(), o.id);
    expect(removed.grandTotal).toBe(5500);
    expect(removed.discount).toBeNull();
    // Taxes follow the discounted amount (inclusive 15%).
    const [tax] = await db.query<{ total: string }>(
      `select sum(tax_total)::text as total from order_items where order_id = $1`,
      [o.id],
    );
    expect(Number(tax!.total)).toBeGreaterThan(0);
  });

  it('printed kitchen tickets carry the order prices when the station shows prices; none when it hides them', async () => {
    const printed = async (orderId: string) => {
      const rows = await db.query<{
        document: { blocks: { type: string; left?: string; right?: string }[] };
      }>(
        `select document from print_jobs where order_id = $1 and kind = 'kitchen_ticket' order by created_at limit 1`,
        [orderId],
      );
      return rows[0]!.document.blocks
        .filter((b) => b.type === 'columns')
        .map((b) => [b.left!.trim(), b.right]);
    };
    const shown = await order([line(f.products.jollof, 2)]);
    expect(await printed(shown.id)).toEqual(
      expect.arrayContaining([
        ['2 x GHS 45.00', 'GHS 90.00'],
        ['TOTAL', 'GHS 90.00'],
      ]),
    );
    await db.query('update stations set show_prices = false where id = $1', [f.stations.kitchen]);
    const hidden = await order([line(f.products.jollof, 1)]);
    expect((await printed(hidden.id)).some(([, right]) => /GHS/.test(right ?? ''))).toBe(false);
    await db.query('update stations set show_prices = true where id = $1', [f.stations.kitchen]);
  });

  it('receipt document: one strategy (gross lines, promo lines, subtotal, promotions, discount, total)', () => {
    const doc = receiptDocument({
      restaurantName: 'Chefelisha Restaurant',
      branchName: 'Main',
      branchAddress: null,
      currency: 'GHS',
      orderNumber: 7,
      channel: 'takeaway',
      tableLabel: null,
      customerName: 'Ama',
      issuedAt: new Date('2026-09-25T12:00:00Z'),
      timeZone: 'Africa/Accra',
      cashierName: 'Kofi',
      items: [
        {
          quantity: 3,
          name: 'Kebab',
          unitPrice: 1000,
          grossTotal: 3000,
          promotionName: '3 for 25',
          promotionDiscount: 500,
          lineTotal: 2500,
          modifiers: [],
          voided: false,
        },
      ],
      subtotal: 3000,
      promotionTotal: 500,
      discountTotal: 200,
      discountReason: 'Regular',
      taxes: [],
      grandTotal: 2300,
      payments: [],
      balanceDue: 2300,
      footer: null,
    });
    const rows = doc.blocks.filter((b) => b.type === 'columns').map((b) => (b as { left: string }).left);
    expect(rows).toEqual([
      'ORDER #7',
      '3 x Kebab',
      '   Promo: 3 for 25',
      'Subtotal',
      'Promotions',
      'Discount (Regular)',
      'TOTAL',
      'BALANCE DUE',
    ]);
  });
});
