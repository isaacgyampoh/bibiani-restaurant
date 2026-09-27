import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpHarness, type HttpHarness } from './harness';

/**
 * PIN-first sign-in: a PIN session is bound (server side) to the device it was opened on.
 * On the person's OWN registered device it carries their full role; on a shared till, staff,
 * device and settings management stay closed. The device header cannot override the binding.
 */
describe('PIN sessions and personal devices', () => {
  let h: HttpHarness;
  let managerStaff: string;
  let personalDevice: string;

  /** A settings change (config.manage): open to the full role only. */
  const call = (token: string, _path: string, deviceId?: string) =>
    h.fetch('http://api.test/v1/admin/config/station', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(deviceId ? { 'x-device-id': deviceId } : {}),
      },
      body: JSON.stringify({
        branchId: h.f.branchId,
        name: `Bar ${randomUUID().slice(0, 4)}`,
        code: `B${randomUUID().slice(0, 3).toUpperCase()}`,
      }),
    });
  const bind = (sessionId: string, deviceId: string) =>
    h.db.query(
      'insert into pin_sessions (session_id, restaurant_id, staff_id, device_id) values ($1, $2, $3, $4)',
      [sessionId, h.f.restaurantId, managerStaff, deviceId],
    );

  beforeAll(async () => {
    h = await createHttpHarness();
    [{ id: managerStaff }] = (await h.db.query<{ id: string }>('select id from staff where user_id = $1', [
      h.f.authUsers.manager,
    ])) as [{ id: string }];
    // Both devices are paired (have their own device login), as any device used for PIN sign-in is.
    const login = async () => {
      const id = randomUUID();
      await h.db.query('insert into auth.users (id) values ($1)', [id]);
      return id;
    };
    await h.db.query('update devices set auth_user_id = $2 where id = $1', [h.f.devices.pos, await login()]);
    [{ id: personalDevice }] = (await h.db.query<{ id: string }>(
      `insert into devices (restaurant_id, branch_id, kind, name, personal_staff_id, auth_user_id)
       values ($1, $2, 'pos', 'Ama device 1', $3, $4) returning id`,
      [h.f.restaurantId, h.f.branchId, managerStaff, await login()],
    )) as [{ id: string }];
  });
  afterAll(() => h.db.close());

  it('on their own device, a PIN session has the full role (management included)', async () => {
    const session = randomUUID();
    await bind(session, personalDevice);
    const token = await h.token(h.f.authUsers.manager, { amr: ['otp'], sessionId: session });
    expect((await call(token, '/v1/admin/configuration')).status).toBe(200);
  });

  it('on a shared till, the same person by PIN cannot manage staff, devices or settings', async () => {
    const session = randomUUID();
    await bind(session, h.f.devices.pos);
    const token = await h.token(h.f.authUsers.manager, { amr: ['otp'], sessionId: session });
    expect((await call(token, '/v1/admin/configuration')).status).toBe(403);
    // Claiming to be on the personal device does not help: the binding wins.
    expect((await call(token, '/v1/admin/configuration', personalDevice)).status).toBe(403);
  });

  it('an "otp" session that is not a bound PIN session came from an email link: email proof, full role', async () => {
    // Supabase marks recovery / magic-link sessions and our PIN sessions alike ("otp"); only PIN
    // sessions are bound to a device, so an unbound one was opened from an emailed link.
    const token = await h.token(h.f.authUsers.manager, { amr: ['otp'], sessionId: randomUUID() });
    expect((await call(token, '/v1/admin/configuration', personalDevice)).status).toBe(200);
    const me = await h.fetch('http://api.test/v1/me', { headers: { authorization: `Bearer ${token}` } });
    expect(((await me.json()) as { signedInWith: string }).signedInWith).toBe('email_link');
  });

  it('an "otp" session without a session id is treated as a PIN session (restricted)', async () => {
    const token = await h.token(h.f.authUsers.manager, { amr: ['otp'] });
    expect((await call(token, '/v1/admin/configuration', personalDevice)).status).toBe(403);
  });

  it('a personal device that is revoked (deactivated) stops giving management', async () => {
    const session = randomUUID();
    await bind(session, personalDevice);
    await h.db.query('update devices set is_active = false where id = $1', [personalDevice]);
    const token = await h.token(h.f.authUsers.manager, { amr: ['otp'], sessionId: session });
    expect((await call(token, '/v1/admin/configuration')).status).toBe(403);
    await h.db.query('update devices set is_active = true where id = $1', [personalDevice]);
  });

  it('password sign-in keeps full access, as before', async () => {
    const token = await h.token(h.f.authUsers.manager, { amr: ['password'] });
    expect((await call(token, '/v1/admin/configuration')).status).toBe(200);
  });
});
