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

  // ---------------------------------------------------------------------------------------------
  // Regression: production incident 2026-09-29 (fresh codes refused, new codes after pairing).
  // ---------------------------------------------------------------------------------------------
  const loginOf = async (deviceId: string) =>
    (
      await db.query<{ u: string | null }>('select auth_user_id as u from devices where id = $1', [deviceId])
    )[0]!.u;
  const count = async (sql: string, params: unknown[] = []) =>
    (await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params))[0]!.n;

  it('a fresh code is accepted immediately, as displayed (dash, lower case, spaces all fine)', async () => {
    for (const typed of [
      (c: string) => c,
      (c: string) => c.toLowerCase(),
      (c: string) => ` ${c.replace('-', ' ')} `,
    ]) {
      const req = await t.app.requestDevicePairing.execute();
      await expect(
        t.app.approveDevicePairing.execute(await manager(), f.devices.display, typed(req.code)),
      ).resolves.toEqual({
        ok: true,
      });
      expect((await t.app.collectDevicePairing.execute(req.secret, 'c')).status).toBe('paired');
    }
  });

  it('an expired code says it expired (and only then)', async () => {
    const req = await t.app.requestDevicePairing.execute();
    t.clock.advance(9 * 60);
    expect(await t.app.collectDevicePairing.execute(req.secret, 'c')).toEqual({ status: 'waiting' });
    t.clock.advance(2 * 60);
    await expect(
      t.app.approveDevicePairing.execute(await manager(), f.devices.display, req.code),
    ).rejects.toMatchObject({
      code: 'PAIRING_CODE_INVALID',
      message: expect.stringContaining('has expired'),
    });
  });

  it('pairing gives one device one login; the code cannot be collected twice; approving twice is harmless', async () => {
    const req = await t.app.requestDevicePairing.execute();
    const devicesBefore = await count('devices');
    await t.app.approveDevicePairing.execute(await manager(), f.devices.display, req.code);
    // The same approval again (double tap / retry): success, nothing changes.
    await expect(
      t.app.approveDevicePairing.execute(await manager(), f.devices.display, req.code),
    ).resolves.toEqual({ ok: true });
    const paired = await t.app.collectDevicePairing.execute(req.secret, 'c');
    expect(paired.status).toBe('paired');
    const login = await loginOf(f.devices.display);
    await expect(t.app.collectDevicePairing.execute(req.secret, 'c')).rejects.toMatchObject({
      code: 'PAIRING_CODE_INVALID',
    });
    expect(await loginOf(f.devices.display)).toBe(login);
    expect(await count('devices')).toBe(devicesBefore);
    // The code, once used, cannot pair another device.
    await expect(
      t.app.approveDevicePairing.execute(await manager(), f.devices.pos, req.code),
    ).rejects.toMatchObject({
      message: expect.stringContaining('already been used'),
    });
  });

  it('two devices, two codes: each code pairs only its own device', async () => {
    const pc1 = await t.app.requestDevicePairing.execute();
    const pc2 = await t.app.requestDevicePairing.execute();
    expect(pc1.code).not.toBe(pc2.code);
    await t.app.approveDevicePairing.execute(await manager(), f.devices.pos, pc2.code);
    expect(await t.app.collectDevicePairing.execute(pc1.secret, 'c')).toEqual({ status: 'waiting' });
    const second = await t.app.collectDevicePairing.execute(pc2.secret, 'c');
    expect(second).toMatchObject({ status: 'paired', device: { id: f.devices.pos } });
  });

  it('asking for a new code (replacing the old one) cancels the old code; the new one works', async () => {
    const a = await t.app.requestDevicePairing.execute();
    const b = await t.app.requestDevicePairing.execute({ replaces: a.secret });
    await expect(
      t.app.approveDevicePairing.execute(await manager(), f.devices.display, a.code),
    ).rejects.toMatchObject({
      message: expect.stringContaining('newer code'),
    });
    await expect(t.app.collectDevicePairing.execute(a.secret, 'c')).rejects.toMatchObject({
      code: 'PAIRING_CODE_INVALID',
    });
    await expect(
      t.app.approveDevicePairing.execute(await manager(), f.devices.display, b.code),
    ).resolves.toEqual({ ok: true });
  });

  it('a code from MY FOOD Printing entered on a till is refused BEFORE anything changes (the till keeps its login)', async () => {
    const req = await t.app.requestDevicePairing.execute({ kind: 'print_agent' });
    const tillLogin = await loginOf(f.devices.pos);
    await expect(
      t.app.approveDevicePairing.execute(await manager(), f.devices.pos, req.code),
    ).rejects.toMatchObject({
      code: 'PAIRING_CODE_INVALID',
      message: expect.stringContaining('MY FOOD Printing'),
    });
    expect(await loginOf(f.devices.pos)).toBe(tillLogin);
    expect(await t.app.collectDevicePairing.execute(req.secret, 'c')).toEqual({ status: 'waiting' });
    // The same code still works on the print agent.
    await t.app.approveDevicePairing.execute(await manager(), f.devices.agent, req.code);
    expect(await t.app.collectDevicePairing.execute(req.secret, 'c')).toMatchObject({
      status: 'paired',
      device: { kind: 'print_agent' },
    });
    // A hub's code on a till is refused the same way.
    const hubReq = await t.app.requestDevicePairing.execute({ kind: 'hub' });
    await expect(
      t.app.approveDevicePairing.execute(await manager(), f.devices.pos, hubReq.code),
    ).rejects.toMatchObject({
      message: expect.stringContaining('MY FOOD Hub'),
    });
  });

  it('a code made with "Create code" typed into "Enter code from device" says where it belongs', async () => {
    const { code } = await t.app.createPairingCode.execute(await manager(), f.devices.display);
    await expect(
      t.app.approveDevicePairing.execute(await manager(), f.devices.display, code),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Type it on the device itself'),
    });
    await expect(
      t.app.approveDevicePairing.execute(await manager(), f.devices.display, 'ZZZZ-ZZZZ'),
    ).rejects.toMatchObject({
      message: expect.stringContaining('not valid'),
    });
  });
});
