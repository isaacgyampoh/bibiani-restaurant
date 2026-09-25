import { randomUUID } from 'node:crypto';
import { type Document, render } from '@rp/escpos';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestDatabase,
  type LocalAuthDirectory,
  type RestaurantFixture,
  seedRestaurant,
  type TestApp,
  type TestDatabase,
} from '../src';
import { line, uuid } from './helpers';

describe('Staff PINs, floor operations, stock reversal, kitchen prices, branded receipt', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;
  let posUser: string;
  const staffIdOf = async (userId: string) =>
    (await db.query<{ id: string }>('select id from staff where user_id = $1', [userId]))[0]!.id;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'pins' });
    t = createTestApp(db);
    // The till's own device login (a paired POS keeps it to unlock staff sessions by PIN).
    posUser = randomUUID();
    await db.query('insert into auth.users (id) values ($1)', [posUser]);
    await db.query('update devices set auth_user_id = $1 where id = $2', [posUser, f.devices.pos]);
  });
  afterAll(() => db.close());

  const till = () => t.as(posUser);
  const owner = () => t.as(f.authUsers.manager);

  describe('PINs', () => {
    it('owner assigns unique PINs; duplicates and weak PINs are refused without revealing the owner', async () => {
      const cashier = await staffIdOf(f.authUsers.cashier);
      const waiter = await staffIdOf(f.authUsers.waiter);
      await t.app.assignStaffPin.execute(await owner(), cashier, '4821');
      await expect(t.app.assignStaffPin.execute(await owner(), waiter, '4821')).rejects.toMatchObject({
        code: 'PIN_IN_USE',
        message: 'This PIN is already in use. Please choose another PIN.',
      });
      for (const weak of ['1111', '1234', '9876', '12', 'abcd'])
        await expect(t.app.assignStaffPin.execute(await owner(), waiter, weak)).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
        });
      await t.app.assignStaffPin.execute(await owner(), waiter, '5902');
      // Only a keyed digest is stored; nothing PIN-like leaves through the API.
      const [row] = await db.query<{ pin_lookup: string }>('select pin_lookup from staff where id = $1', [
        cashier,
      ]);
      expect(row!.pin_lookup).toMatch(/^[0-9a-f]{64}$/);
      expect(row!.pin_lookup).not.toContain('4821');
      const config = JSON.stringify(await t.app.getConfiguration.execute(await owner()));
      expect(config).not.toMatch(/pin_lookup|pinLookup|4821/);
      // Cashiers cannot assign PINs.
      await expect(
        t.app.assignStaffPin.execute(await t.as(f.authUsers.cashier), waiter, '7310'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('PIN sign-in works only on a registered till, returns a session, and asks for activation', async () => {
      const auth = (t.app as unknown as { pinSignIn: { deps: { auth: LocalAuthDirectory } } }).pinSignIn.deps
        .auth;
      const before = auth.sessions.length;
      const result = await t.app.pinSignIn.execute(await till(), '4821');
      expect(result).toMatchObject({ displayName: 'Kofi Cashier', mustChangePin: true });
      expect(auth.sessions.slice(before)).toEqual([f.authUsers.cashier]);
      await expect(t.app.pinSignIn.execute(await t.as(f.authUsers.kitchenKds), '4821')).rejects.toMatchObject(
        {
          code: 'FORBIDDEN',
        },
      );
      await expect(t.app.pinSignIn.execute(await owner(), '4821')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(t.app.pinSignIn.execute(await till(), '0000')).rejects.toMatchObject({
        code: 'PIN_INVALID',
        message: 'PIN not recognised',
      });
    });

    it('activation: the staff member replaces the assigned PIN; the old PIN stops working', async () => {
      const kofi = await t.as(f.authUsers.cashier, f.devices.pos);
      await t.app.changeOwnPin.execute({ ...kofi, authMethod: 'pin' }, { newPin: '7358' });
      await expect(t.app.pinSignIn.execute(await till(), '4821')).rejects.toMatchObject({
        code: 'PIN_INVALID',
      });
      expect((await t.app.pinSignIn.execute(await till(), '7358')).mustChangePin).toBe(false);
      // A later change needs the current PIN (or an email link).
      await expect(
        t.app.changeOwnPin.execute({ ...kofi, authMethod: 'pin' }, { currentPin: '9999', newPin: '8246' }),
      ).rejects.toMatchObject({ message: 'Your current PIN is not correct' });
      await t.app.changeOwnPin.execute({ ...kofi, authMethod: 'email_link' }, { newPin: '8246' });
      await expect(t.app.pinSignIn.execute(await till(), '7358')).rejects.toMatchObject({
        code: 'PIN_INVALID',
      });
      await t.app.pinSignIn.execute(await till(), '8246');
      const audit = await db.query<{ action: string }>(
        `select action from audit_logs where entity_id = $1 and action like 'staff.pin%' order by id`,
        [await staffIdOf(f.authUsers.cashier)],
      );
      expect(audit.map((a) => a.action)).toEqual([
        'staff.pin_assigned',
        'staff.pin_sign_in',
        'staff.pin_activated',
        'staff.pin_sign_in',
        'staff.pin_changed',
        'staff.pin_sign_in',
      ]);
    });

    it('repeated wrong PINs lock the till for a while; attempts are recorded; the lock expires', async () => {
      t.clock.advance(11 * 60); // start from a clean window
      for (let i = 0; i < 5; i++)
        await expect(t.app.pinSignIn.execute(await till(), `90${i}7`)).rejects.toMatchObject({
          code: 'PIN_INVALID',
        });
      await expect(t.app.pinSignIn.execute(await till(), '8246')).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
      expect(
        await db.query(`select 1 from audit_logs where action = 'security.pin_lockout' and entity_id = $1`, [
          f.devices.pos,
        ]),
      ).toHaveLength(1);
      const [attempts] = await db.query<{ n: number }>(
        `select count(*)::int as n from pin_attempts where device_id = $1 and not succeeded`,
        [f.devices.pos],
      );
      expect(attempts!.n).toBeGreaterThanOrEqual(6);
      t.clock.advance(11 * 60);
      await t.app.pinSignIn.execute(await till(), '8246');
    });

    it('forgot PIN: a recovery email goes only to a registered staff address; the answer never differs', async () => {
      const auth = (t.app as unknown as { pinSignIn: { deps: { auth: LocalAuthDirectory } } }).pinSignIn.deps
        .auth;
      await db.query(`update staff set email = 'esi@example.com' where user_id = $1`, [f.authUsers.waiter]);
      const before = auth.recoveryEmails.length;
      expect(await t.app.requestPinRecovery.execute(await till(), 'nobody@example.com')).toEqual({
        ok: true,
      });
      expect(await t.app.requestPinRecovery.execute(await till(), 'ESI@example.com')).toEqual({ ok: true });
      expect(auth.recoveryEmails.slice(before)).toEqual([
        { email: 'esi@example.com', redirectTo: 'https://app.test/reset-pin' },
      ]);
    });
  });

  describe('Stock: sale, replay, cancellation reversal', () => {
    it('a sale deducts once (replays do not), cancellation returns it once (repeats do not)', async () => {
      const m = await owner();
      const { id: rice } = await t.app.saveInventoryItem.execute(m, {
        branchId: f.branchId,
        name: 'Rice',
        unit: 'kg',
        minQuantity: 1,
        unitCost: 1000,
        isActive: true,
      });
      await t.app.recordStockMovement.execute(m, {
        movementId: uuid(),
        itemId: rice,
        kind: 'receive',
        quantity: 10,
      });
      await t.app.saveRecipe.execute(m, f.products.jollof, {
        components: [{ itemId: rice, quantity: 0.25 }],
      });
      const stock = async () =>
        (await t.app.listInventory.execute(m, f.branchId)).items.find((i) => i.id === rice)!.quantity;

      const cmd = {
        orderId: uuid(),
        branchId: f.branchId,
        areaId: f.areas.takeaway,
        items: [line(f.products.jollof, 2)],
        send: { submissionId: uuid() },
      };
      const cashier = await t.as(f.authUsers.cashier, f.devices.pos);
      const order = await t.app.submitOrder.execute(cashier, cmd);
      await t.app.submitOrder.execute(cashier, cmd); // retry of the same request
      expect(await stock()).toBe(9.5);

      await t.app.cancelOrder.execute(m, order.id, { reason: 'Customer left' });
      expect(await stock()).toBe(10);
      await t.app.cancelOrder.execute(m, order.id, { reason: 'Customer left' }); // repeated cancel
      expect(await stock()).toBe(10);
      // The database itself refuses a second reversal for the same order and item.
      await expect(
        db.query(
          `insert into stock_movements (id, restaurant_id, branch_id, item_id, kind, quantity_delta, quantity_after, order_id)
           values ($1, $2, $3, $4, 'sale_reversal', 0.5, 10.5, $5)`,
          [uuid(), f.restaurantId, f.branchId, rice, order.id],
        ),
      ).rejects.toBeTruthy();
      const ledger = await t.app.listStockMovements.execute(m, f.branchId, rice);
      expect(ledger.map((x) => [x.kind, x.quantityDelta])).toEqual([
        ['sale_reversal', 0.5],
        ['sale', -0.5],
        ['receive', 10],
      ]);
      const [audit] = await db.query<{ after_data: { stockItemsReturned: number } }>(
        `select after_data from audit_logs where action = 'order.cancel' and entity_id = $1`,
        [order.id],
      );
      expect(audit!.after_data.stockItemsReturned).toBe(1);
    });
  });

  describe('Floor operations', () => {
    const dineIn = async (tableLabel: string, items = [line(f.products.coke, 1)]) =>
      t.app.submitOrder.execute(await t.as(f.authUsers.waiter, f.devices.pos), {
        orderId: uuid(),
        branchId: f.branchId,
        areaId: f.areas.hall,
        tableId: f.tables[tableLabel],
        items,
        send: { submissionId: uuid() },
      });

    it('transfer to a free table; refused onto an occupied one; convert to takeaway', async () => {
      const a = await dineIn('1');
      const moved = await t.app.transferOrder.execute(await owner(), a.id, {
        areaId: f.areas.hall,
        tableId: f.tables['2'],
      });
      expect(moved.table?.label).toBe('2');
      const b = await dineIn('1');
      await expect(
        t.app.transferOrder.execute(await owner(), b.id, { areaId: f.areas.hall, tableId: f.tables['2'] }),
      ).rejects.toMatchObject({ code: 'TABLE_UNAVAILABLE' });
      const takeaway = await t.app.transferOrder.execute(await owner(), b.id, {
        areaId: f.areas.takeaway,
        customerName: 'Yaw',
      });
      expect(takeaway).toMatchObject({ channel: 'takeaway', table: null, customerName: 'Yaw' });
      // History kept.
      expect(
        await db.query(`select 1 from order_events where order_id = $1 and event = 'order.transferred'`, [
          b.id,
        ]),
      ).toHaveLength(1);
      await t.app.cancelOrder.execute(await owner(), a.id, { reason: 'test cleanup' });
      await t.app.cancelOrder.execute(await owner(), b.id, { reason: 'test cleanup' });
    });

    it('merge: one bill with both orders’ items and payments; the merged order is closed and points at it', async () => {
      const a = await dineIn('1', [line(f.products.coke, 1)]);
      const b = await dineIn('2', [line(f.products.jollof, 1)]);
      await t.app.recordPayment.execute(await t.as(f.authUsers.cashier, f.devices.pos), b.id, {
        paymentId: uuid(),
        method: 'cash',
        amount: 1000,
      });
      const merged = await t.app.mergeOrders.execute(await owner(), a.id, b.id);
      expect(merged.items.map((i) => i.name).sort()).toEqual(['Coke', 'Jollof Rice']);
      expect(merged.grandTotal).toBe(a.grandTotal + b.grandTotal);
      expect(merged.payments).toHaveLength(1);
      expect(merged.tickets).toHaveLength(2);
      const source = await t.app.getOrder.execute(await owner(), b.id);
      expect(source).toMatchObject({
        status: 'cancelled',
        mergedIntoOrderId: a.id,
        table: null,
        grandTotal: 0,
      });
      // Kitchen now shows the merged ticket under the target's number.
      const [ticket] = await db.query<{ order_number: number }>(
        'select order_number from production_tickets where id = $1',
        [merged.tickets.find((x) => x.stationName === 'Main Kitchen')!.id],
      );
      expect(ticket!.order_number).toBe(a.orderNumber);
      await expect(t.app.mergeOrders.execute(await owner(), a.id, b.id)).rejects.toMatchObject({
        code: 'ORDER_CLOSED',
      });
    });

    it('rush orders go first on kitchen screens; stations can show authoritative prices', async () => {
      const normal = await dineIn('12', [line(f.products.coke, 2)]);
      const rush = await t.app.submitOrder.execute(await t.as(f.authUsers.cashier, f.devices.pos), {
        orderId: uuid(),
        branchId: f.branchId,
        areaId: f.areas.takeaway,
        items: [line(f.products.coke, 1)],
        send: { submissionId: uuid() },
      });
      await t.app.setOrderPriority.execute(await owner(), rush.id, true);
      await db.query('update stations set show_prices = true where id = $1', [f.stations.drinks]);
      const board = (await t.app.getStationBoard.execute(await owner(), f.stations.drinks))!;
      const ids = board.tickets.map((x) => x.orderId);
      expect(ids.indexOf(rush.id)).toBeLessThan(ids.indexOf(normal.id));
      expect(board.tickets.find((x) => x.orderId === rush.id)!.isRush).toBe(true);
      expect(board.station.showPrices).toBe(true);
      expect(board.tickets.find((x) => x.orderId === normal.id)!.items[0]!.lineTotal).toBe(normal.grandTotal);
    });
  });

  it('branded receipt: logo, restaurant name, phone, unit prices; the printer gets the logo raster', async () => {
    await db.query(
      `update restaurants set name = 'Chefelisha Restaurant', phone = '+233 20 000 0000' where id = $1`,
      [f.restaurantId],
    );
    const order = await t.app.submitOrder.execute(await t.as(f.authUsers.cashier, f.devices.pos), {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(f.products.coke, 3)],
      send: { submissionId: uuid() },
    });
    const receipt = await t.app.getReceipt.execute(await owner(), order.id);
    const blocks = receipt.document.blocks;
    expect(blocks[0]).toEqual({ type: 'logo' });
    const texts = blocks.map((b) => ('text' in b ? b.text : 'left' in b ? b.left : ''));
    expect(texts).toEqual(expect.arrayContaining(['CHEFELISHA RESTAURANT', 'Tel: +233 20 000 0000']));
    expect(texts.some((x) => x.includes('@ GHS 10.00 each'))).toBe(true);
    const bytes = render(receipt.document as unknown as Document, { paperWidthMm: 80 });
    const gsv0 = bytes.findIndex((b, i) => b === 0x1d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30);
    expect(gsv0).toBeGreaterThan(-1);
    expect(bytes.length).toBeGreaterThan(8192); // 256x256 1-bit logo is 8 KB
  });
});
