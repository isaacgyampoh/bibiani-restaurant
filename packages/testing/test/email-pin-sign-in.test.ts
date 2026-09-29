import { HmacPinHasher } from '@rp/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestDatabase,
  type RestaurantFixture,
  seedRestaurant,
  type TestApp,
  type TestDatabase,
} from '../src';

/**
 * Owner / manager on a new phone or laptop: email + PIN, no emailed link. A correct pair registers
 * the device as theirs (so next time only the PIN is asked). Wrong PINs lock only that account,
 * never the restaurant's tills, and staff without management rights cannot use it.
 */
describe('Email + PIN sign-in on a new device', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;
  const pins = new HmacPinHasher('test-pepper-0123456789abcdef0123456789abcdef');
  const OWNER = 'owner@chefelisha.example';
  const setPin = async (authUser: string, email: string, pin: string) =>
    db.query(`update staff set email = $2, pin_lookup = $3, pin_must_change = false where user_id = $1`, [
      authUser,
      email,
      pins.lookup(f.restaurantId, pin),
    ]);
  const signIn = (email: string, pin: string) =>
    t.app.signInWithEmailAndPin.execute({ email, pin, correlationId: 'test' });

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'email-pin' });
    t = createTestApp(db);
    await setPin(f.authUsers.manager, OWNER, '482913');
    await setPin(f.authUsers.waiter, 'waiter@chefelisha.example', '739151');
  });
  afterAll(() => db.close());

  it('the owner signs in with email + PIN; this device becomes theirs and their PIN works on it', async () => {
    const result = await signIn('  Owner@Chefelisha.example ', '482913');
    expect(result.device.kind).toBe('pos');
    const [device] = await db.query<{ personal: string | null }>(
      `select d.personal_staff_id as personal from devices d where d.id = $1`,
      [result.device.id],
    );
    const [{ id: ownerStaff }] = (await db.query<{ id: string }>('select id from staff where user_id = $1', [
      f.authUsers.manager,
    ])) as [{ id: string }];
    expect(device!.personal).toBe(ownerStaff);
    // The device itself then unlocks with the PIN alone (the normal till sign-in).
    const onDevice = await t.as(await deviceUser(result.device.id));
    const session = await t.app.pinSignIn.execute(onDevice, '482913');
    expect(session.displayName).toBe('Ama Owner');
    const [audit] = await db.query<{ n: number }>(
      `select count(*)::int as n from audit_logs where action = 'staff.email_pin_sign_in'`,
    );
    expect(audit!.n).toBe(1);
  });

  it('wrong PIN and unknown email get the same answer; staff without management rights cannot use it', async () => {
    await expect(signIn(OWNER, '111999')).rejects.toMatchObject({
      code: 'PIN_INVALID',
      message: 'Email or PIN not recognised',
    });
    await expect(signIn('nobody@example.com', '482913')).rejects.toMatchObject({
      code: 'PIN_INVALID',
      message: 'Email or PIN not recognised',
    });
    await expect(signIn('waiter@chefelisha.example', '739151')).rejects.toMatchObject({
      code: 'PIN_INVALID',
    });
  });

  it('5 wrong PINs lock that account for 10 minutes; the restaurant tills are not locked', async () => {
    for (let i = 0; i < 4; i++)
      await expect(signIn(OWNER, '222888')).rejects.toMatchObject({ code: 'PIN_INVALID' });
    // 1 failure from the previous test + 4 = 5: now even the right PIN is refused.
    await expect(signIn(OWNER, '482913')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // A till still works for everyone.
    const [{ id: tillUser }] = (await db.query<{ id: string }>(
      `insert into auth.users (id) values (gen_random_uuid()) returning id`,
    )) as [{ id: string }];
    await db.query('update devices set auth_user_id = $2 where id = $1', [f.devices.pos, tillUser]);
    const till = await t.as(tillUser);
    expect((await t.app.pinSignIn.execute(till, '739151')).displayName).toBe('Esi Waiter');
    // After 10 minutes the account can sign in again.
    t.clock.advance(11 * 60);
    await expect(signIn(OWNER, '482913')).resolves.toBeTruthy();
  });

  it('10 wrong PINs in a day lock email + PIN sign-in for the day', async () => {
    for (let i = 0; i < 4; i++)
      await expect(signIn(OWNER, '333777')).rejects.toMatchObject({ code: 'PIN_INVALID' });
    t.clock.advance(11 * 60);
    await expect(signIn(OWNER, '333777')).rejects.toMatchObject({ code: 'PIN_INVALID' }); // 10th today
    await expect(signIn(OWNER, '482913')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: expect.stringContaining('today'),
    });
  });

  async function deviceUser(deviceId: string): Promise<string> {
    const [r] = await db.query<{ auth_user_id: string }>('select auth_user_id from devices where id = $1', [
      deviceId,
    ]);
    return r!.auth_user_id;
  }
});
