import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestDatabase,
  HOSTED,
  type RestaurantFixture,
  seedRestaurant,
  type TestApp,
  type TestDatabase,
} from '../src';
import { line, uuid } from './helpers';

describe('Administration: configuration, staff, device pairing', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let other: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'admin' });
    other = await seedRestaurant(db, { slug: 'admin-other' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());

  it('an owner configures a new station, printer, routing rule and product, and orders route there', async () => {
    const owner = await t.as(f.authUsers.manager);
    const { id: stationId } = await t.app.saveConfig.execute(owner, 'station', {
      branchId: f.branchId,
      name: 'Bar',
      code: 'BAR',
    });
    const { id: printerId } = await t.app.saveConfig.execute(owner, 'device', {
      branchId: f.branchId,
      kind: 'printer',
      name: 'BAR-PRINTER-01',
      printer: { address: '192.168.1.70:9100', agentDeviceId: f.devices.agent },
    });
    await t.app.saveConfig.execute(owner, 'stationOutput', { stationId, deviceId: printerId });
    const { id: categoryId } = await t.app.saveConfig.execute(owner, 'category', { name: 'Cocktails' });
    const { id: productId } = await t.app.saveConfig.execute(owner, 'product', {
      categoryId,
      name: 'Mojito',
      basePrice: 5000,
      taxRateIds: [f.taxRateId],
    });
    await t.app.saveConfig.execute(owner, 'routingRule', {
      branchId: f.branchId,
      match: 'category',
      categoryId,
      stationId,
    });

    const order = await t.app.submitOrder.execute(await t.as(f.authUsers.cashier), {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(productId, 2)],
      send: { submissionId: uuid() },
    });
    expect(order.tickets).toHaveLength(1);
    expect(order.tickets[0]!.stationName).toBe('Bar');
    expect(order.tickets[0]!.printJobs[0]!.printerId).toBe(printerId);

    const audit = await db.query<{ action: string }>(
      `select action from audit_logs where restaurant_id = $1 and action like 'config.%' order by id`,
      [f.restaurantId],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'config.station.create',
      'config.device.create',
      'config.stationOutput.create',
      'config.category.create',
      'config.product.create',
      'config.routingRule.create',
    ]);
    // Price change is audited with before/after and does not touch existing orders.
    await t.app.saveConfig.execute(owner, 'product', {
      id: productId,
      categoryId,
      name: 'Mojito',
      basePrice: 6000,
      taxRateIds: [f.taxRateId],
    });
    const [change] = await db.query<{
      before_data: { base_price: number };
      after_data: { basePrice: number };
    }>(
      `select before_data, after_data from audit_logs where entity_id = $1 and action = 'config.product.update'`,
      [productId],
    );
    expect(Number(change!.before_data.base_price)).toBe(5000);
    expect(change!.after_data.basePrice).toBe(6000);
    expect((await t.app.getOrder.execute(owner, order.id)).items[0]!.unitPrice).toBe(5000);
  });

  it('configuration is permission-checked and cannot reach another restaurant', async () => {
    const cashier = await t.as(f.authUsers.cashier);
    await expect(t.app.saveConfig.execute(cashier, 'category', { name: 'Hack' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const owner = await t.as(f.authUsers.manager);
    // Overwriting another tenant's product by id is refused by the database (RLS), not just by the app.
    const [theirs] = await db.query<{ id: string; category_id: string }>(
      'select id, category_id from products where restaurant_id = $1 limit 1',
      [other.restaurantId],
    );
    await expect(
      t.app.saveConfig.execute(owner, 'product', {
        id: theirs!.id,
        categoryId: theirs!.category_id,
        name: 'Stolen',
        basePrice: 1,
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|VALIDATION_FAILED/) });
    const [still] = await db.query<{ name: string }>('select name from products where id = $1', [theirs!.id]);
    expect(still!.name).not.toBe('Stolen');
    await expect(
      t.app.saveConfig.execute(owner, 'station', { branchId: other.branchId, name: 'X', code: 'X1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(t.app.saveConfig.execute(owner, 'category', { name: '' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('staff: owner creates a cashier who can sign in with exactly cashier permissions; deactivation locks them out', async () => {
    const owner = await t.as(f.authUsers.manager);
    const config = await t.app.getConfiguration.execute(owner);
    const cashierRole = config.roles.find((r) => r.name === 'Cashier')!;
    const email = `cashier-${uuid().slice(0, 8)}@fixtures.example.com`;
    const { staffId } = await t.app.createStaff.execute(owner, {
      displayName: 'Abena',
      email,
      password: 'correct-horse-battery',
      roleIds: [cashierRole.id],
      branchId: f.branchId,
    });
    const [row] = await db.query<{ user_id: string }>('select user_id from staff where id = $1', [staffId]);
    const resolved = await t.resolver.resolve(row!.user_id, null);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const perms = [...resolved.principal.grants[0]!.permissions].sort();
    expect(perms).toEqual([...cashierRole.permissions].sort());
    expect(resolved.principal.grants[0]!.branchId).toBe(f.branchId);

    await t.app.updateStaff.execute(owner, staffId, { isActive: false });
    expect((await t.resolver.resolve(row!.user_id, null)).ok).toBe(false);
    expect(
      await db.query(`select 1 from audit_logs where entity_id = $1 and action like 'staff.%'`, [staffId]),
    ).toHaveLength(2);
  });

  it('device pairing: one-time code -> device login with station-scoped access; code cannot be reused; revoke ends access', async () => {
    const owner = await t.as(f.authUsers.manager);
    const { id: deviceId } = await t.app.saveConfig.execute(owner, 'device', {
      branchId: f.branchId,
      kind: 'kds',
      name: 'PASTRY-KDS-02',
      stationId: f.stations.pastry,
    });
    const { code, expiresAt } = await t.app.createPairingCode.execute(owner, deviceId);
    expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{8}$/);
    expect(new Date(expiresAt).getTime() - t.clock.now().getTime()).toBe(10 * 60 * 1000);
    const [stored] = await db.query<{ code_hash: string }>(
      'select code_hash from device_pairing_codes where device_id = $1',
      [deviceId],
    );
    expect(stored!.code_hash).not.toContain(code); // only a hash is stored

    const paired = await t.app.pairDevice.execute({ code: code.toLowerCase() }, uuid());
    expect(paired.device).toMatchObject({ id: deviceId, kind: 'kds', stationId: f.stations.pastry });
    expect(paired.session.refreshToken.length).toBeGreaterThan(0);
    await expect(t.app.pairDevice.execute({ code }, uuid())).rejects.toMatchObject({
      code: 'PAIRING_CODE_INVALID',
    });

    const [dev] = await db.query<{ auth_user_id: string }>('select auth_user_id from devices where id = $1', [
      deviceId,
    ]);
    const kds = await t.as(dev!.auth_user_id);
    expect(kds.principal).toMatchObject({
      kind: 'device',
      deviceKind: 'kds',
      deviceStationId: f.stations.pastry,
    });
    await expect(t.app.getStationBoard.execute(kds, f.stations.kitchen)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await t.app.getStationBoard.execute(kds, f.stations.pastry)).station.name).toBe('Pastry');

    // Re-pairing replaces the identity: the old login stops working.
    const second = await t.app.createPairingCode.execute(owner, deviceId);
    await t.app.pairDevice.execute({ code: second.code }, uuid());
    expect((await t.resolver.resolve(dev!.auth_user_id, null)).ok).toBe(false);

    await t.app.revokeDevice.execute(owner, deviceId);
    const [after] = await db.query<{ auth_user_id: string | null }>(
      'select auth_user_id from devices where id = $1',
      [deviceId],
    );
    expect(after!.auth_user_id).toBeNull();
    const actions = await db.query<{ action: string }>(
      `select action from audit_logs where entity_id = $1 order by id`,
      [deviceId],
    );
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['device.pairing_code_created', 'device.paired', 'device.revoked']),
    );
  });

  it('expired pairing codes are rejected', async () => {
    const owner = await t.as(f.authUsers.manager);
    const { code } = await t.app.createPairingCode.execute(owner, f.devices.display);
    // Expiry is judged by the application clock, so move that clock past the 10-minute validity.
    t.clock.advance(11 * 60);
    await expect(t.app.pairDevice.execute({ code }, uuid())).rejects.toMatchObject({
      code: 'PAIRING_CODE_INVALID',
    });
  });

  it('operations view reports device liveness from heartbeats and printer health from the agent', async () => {
    const agent = await t.as(f.authUsers.agent);
    await t.app.recordHeartbeat.execute(agent, {
      appVersion: '0.1.0',
      printers: [
        { printerId: f.printers.kitchen, ok: true },
        { printerId: f.printers.grill, ok: false, error: 'ECONNREFUSED' },
      ],
    });
    const owner = await t.as(f.authUsers.manager);
    const view = await t.app.getOperationsStatus.execute(owner, f.branchId);
    const by = (name: string) => view.devices.find((d) => d.name === name)!;
    expect(HOSTED || by('AGENT-01').status === 'online').toBe(true); // hosted clock skew: checked below via lastSeenAt
    expect(by('AGENT-01').lastSeenAt).not.toBeNull();
    expect(by('KITCHEN-PRINTER-01').printer).toMatchObject({ healthy: true });
    expect(by('GRILL-PRINTER-01').printer).toMatchObject({ healthy: false, lastError: 'ECONNREFUSED' });
    expect(by('POS-01').status).toBe('never_seen');
  });
  it('modifier groups and modifiers are managed in admin, shown on the POS menu and priced on orders', async () => {
    const owner = await t.as(f.authUsers.manager);
    const { id: groupId } = await t.app.saveConfig.execute(owner, 'modifierGroup', {
      name: 'Spice level',
      minSelect: 0,
      maxSelect: 1,
    });
    const { id: extraHot } = await t.app.saveConfig.execute(owner, 'modifier', {
      groupId,
      name: 'Extra hot',
      priceDelta: 200,
    });
    await t.app.saveConfig.execute(owner, 'product', {
      id: f.products.chicken,
      categoryId: (
        await db.query<{ category_id: string }>('select category_id from products where id = $1', [
          f.products.chicken,
        ])
      )[0]!.category_id,
      name: 'Grilled Chicken',
      basePrice: 6000,
      modifierGroupIds: [groupId],
    });
    const config = await t.app.getConfiguration.execute(owner);
    expect(config.modifierGroups.some((g) => g.id === groupId)).toBe(true);
    expect(config.modifiers.find((m) => m.id === extraHot)).toMatchObject({
      name: 'Extra hot',
      priceDelta: 200,
    });
    expect(config.products.find((p) => p.id === f.products.chicken)?.modifierGroupIds).toEqual([groupId]);

    const menu = await t.app.getMenu.execute(owner, f.branchId);
    const chicken = menu.products.find((p) => p.id === f.products.chicken)!;
    expect(chicken.modifierGroups.map((g) => g.name)).toEqual(['Spice level']);
    const order = await t.app.submitOrder.execute(await t.as(f.authUsers.cashier, f.devices.pos), {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(f.products.chicken, 1, { modifierIds: [extraHot] })],
      send: { submissionId: uuid() },
    });
    expect(order.grandTotal).toBe(6200);

    // Saving a product without modifierGroupIds leaves its groups alone.
    await t.app.saveConfig.execute(owner, 'product', {
      id: f.products.chicken,
      categoryId: chicken.categoryId,
      name: 'Grilled Chicken',
      basePrice: 6000,
    });
    const again = await t.app.getMenu.execute(owner, f.branchId);
    expect(again.products.find((p) => p.id === f.products.chicken)!.modifierGroups).toHaveLength(1);

    await expect(
      t.app.saveConfig.execute(await t.as(f.authUsers.cashier), 'modifier', { groupId, name: 'Mild' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
