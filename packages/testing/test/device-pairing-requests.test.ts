import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestDatabase,
  type RestaurantFixture,
  seedRestaurant,
  type TestApp,
  type TestDatabase,
} from '../src';

describe('Device-initiated pairing (device shows a code, manager approves)', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let other: RestaurantFixture;
  let t: TestApp;
  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'pairreq' });
    other = await seedRestaurant(db, { slug: 'pairreq-other' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());
  const manager = () => t.as(f.authUsers.manager);

  it('the device waits, the manager approves the code shown on it, the device gets its own login once', async () => {
    const req = await t.app.requestDevicePairing.execute();
    expect(req.code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    expect(req.secret.length).toBeGreaterThanOrEqual(32);
    // Only hashes are stored.
    const stored = JSON.stringify(await db.query('select * from device_pairing_requests'));
    expect(stored).not.toContain(req.code.replace('-', ''));
    expect(stored).not.toContain(req.secret);

    expect(await t.app.collectDevicePairing.execute(req.secret, 'c1')).toEqual({ status: 'waiting' });
    await expect(
      t.app.approveDevicePairing.execute(await manager(), f.devices.display, 'ABCD-EFGH'),
    ).rejects.toMatchObject({
      code: 'PAIRING_CODE_INVALID',
    });
    await expect(
      t.app.approveDevicePairing.execute(
        await t.as(f.authUsers.cashier, f.devices.pos),
        f.devices.display,
        req.code,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A manager cannot approve another restaurant's device.
    await expect(
      t.app.approveDevicePairing.execute(await manager(), other.devices.display, req.code),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // Lowercase and without the dash is fine (typed on a keyboard).
    await t.app.approveDevicePairing.execute(
      await manager(),
      f.devices.display,
      req.code.toLowerCase().replace('-', ''),
    );
    const paired = await t.app.collectDevicePairing.execute(req.secret, 'c2');
    expect(paired).toMatchObject({
      status: 'paired',
      device: { id: f.devices.display, kind: 'customer_display' },
    });
    const [d] = await db.query<{ auth_user_id: string | null }>(
      'select auth_user_id from devices where id = $1',
      [f.devices.display],
    );
    expect(d!.auth_user_id).not.toBeNull();
    const audit = await db.query<{ action: string }>(
      `select action from audit_logs where entity_id = $1 and action like 'device.pair%' order by created_at`,
      [f.devices.display],
    );
    expect(audit.map((a) => a.action)).toEqual(['device.pairing_approved', 'device.paired']);
    // Single use.
    await expect(t.app.collectDevicePairing.execute(req.secret, 'c3')).rejects.toMatchObject({
      code: 'PAIRING_CODE_INVALID',
    });
  });

  it('codes expire after 10 minutes and printers are never paired', async () => {
    const req = await t.app.requestDevicePairing.execute();
    await expect(
      t.app.approveDevicePairing.execute(await manager(), f.printers.kitchen, req.code),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    t.clock.advance(11 * 60);
    await expect(
      t.app.approveDevicePairing.execute(await manager(), f.devices.display, req.code),
    ).rejects.toMatchObject({
      code: 'PAIRING_CODE_INVALID',
    });
    await expect(t.app.collectDevicePairing.execute(req.secret, 'c')).rejects.toMatchObject({
      code: 'PAIRING_CODE_INVALID',
    });
  });
});
