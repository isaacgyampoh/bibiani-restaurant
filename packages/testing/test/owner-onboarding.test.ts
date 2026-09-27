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

describe('Owner onboarding (invitation, email proof, Owner role)', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;
  let auth: LocalAuthDirectory;
  // Expiry relative to the app's (test) clock, not the database's.
  const invite = (email: string, days = 7) =>
    db.query(`insert into owner_invitations (restaurant_id, email, expires_at) values ($1, $2, $3)`, [
      f.restaurantId,
      email,
      new Date(t.clock.now().getTime() + days * 86_400_000).toISOString(),
    ]);
  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'onboard' });
    t = createTestApp(db);
    auth = (t.app as unknown as { startOwnerOnboarding: { deps: { auth: LocalAuthDirectory } } })
      .startOwnerOnboarding.deps.auth;
  });
  afterAll(() => db.close());

  it('the welcome screen answers the same for every email; only an invited email gets a link', async () => {
    const before = auth.recoveryEmails.length;
    await expect(
      t.app.startOwnerOnboarding.execute({ email: 'stranger@example.com', correlationId: 'c1' }),
    ).resolves.toEqual({ ok: true });
    expect(auth.recoveryEmails.length).toBe(before);
    await expect(
      t.app.startOwnerOnboarding.execute({ email: 'not-an-email', correlationId: 'c' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await invite('akosua@client.example');
    await expect(
      t.app.startOwnerOnboarding.execute({ email: '  Akosua@Client.example ', correlationId: 'c2' }),
    ).resolves.toEqual({ ok: true });
    expect(auth.recoveryEmails.slice(before)).toEqual([
      { email: 'akosua@client.example', redirectTo: 'https://app.test/welcome/verify' },
    ]);
    // Asking twice is harmless (the login already exists; another link is sent).
    await t.app.startOwnerOnboarding.execute({ email: 'akosua@client.example', correlationId: 'c3' });
    expect(auth.recoveryEmails.length).toBe(before + 2);
  });

  it('only an email-link session can accept; then the owner has full management access', async () => {
    const userId = auth.users.get('akosua@client.example')!.id;
    await expect(
      t.app.acceptOwnerInvitation.execute({
        authUserId: userId,
        authMethods: ['password'],
        fullName: 'Akosua Mensah',
        pin: '5821',
        correlationId: 'c',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A PIN session is a magic-link session: it is not proof of the email address.
    await expect(
      t.app.acceptOwnerInvitation.execute({
        authUserId: userId,
        authMethods: ['otp'],
        fullName: 'Akosua Mensah',
        pin: '5821',
        correlationId: 'c',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const result = await t.app.acceptOwnerInvitation.execute({
      authUserId: userId,
      authMethods: ['recovery'],
      fullName: 'Akosua   Mensah',
      pin: '5821',
      correlationId: 'c4',
    });
    expect(result).toMatchObject({ restaurantId: f.restaurantId });
    // This browser became the owner's personal device; the PIN signs her in there.
    expect(result.device.device).toMatchObject({ kind: 'pos', name: 'Akosua device 1' });
    const [dev] = await db.query<{ personal_staff_id: string | null; auth_user_id: string | null }>(
      'select personal_staff_id, auth_user_id from devices where id = $1',
      [result.device.device.id],
    );
    expect(dev!.personal_staff_id).not.toBeNull();
    const signedIn = await t.app.pinSignIn.execute(await t.as(dev!.auth_user_id!), '5821');
    expect(signedIn.mustChangePin).toBe(false);
    expect(signedIn.displayName).toBe('Akosua Mensah');
    const owner = await t.as(userId);
    const config = await t.app.getConfiguration.execute(owner);
    expect(config.staff.find((s) => s.displayName === 'Akosua Mensah')).toBeTruthy();
    expect(owner.principal.grants.some((g) => g.branchId === null && g.permissions.has('staff.manage'))).toBe(
      true,
    );
    const [inv] = await db.query<{ accepted_at: Date | null }>(
      `select accepted_at from owner_invitations where email = 'akosua@client.example'`,
    );
    expect(inv!.accepted_at).not.toBeNull();
    const audit = await db.query<{ action: string }>(
      `select action from audit_logs where action like 'owner.%' order by created_at`,
    );
    expect(audit.map((a) => a.action)).toEqual([
      'owner.verification_sent',
      'owner.verification_sent',
      'owner.onboarded',
    ]);
    // Nothing sensitive in the audit record.
    expect(
      JSON.stringify(await db.query('select after_data from audit_logs where action like $1', ['owner.%'])),
    ).not.toMatch(/password|token|5821/i);
    // The invitation is used up: it cannot make anyone else Owner.
    await expect(
      t.app.acceptOwnerInvitation.execute({
        authUserId: userId,
        authMethods: ['recovery'],
        fullName: 'X Y',
        pin: '7394',
        correlationId: 'c',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('the owner PIN must be unique, and the refusal never says whose PIN it is', async () => {
    await invite('kojo@client.example');
    await t.app.startOwnerOnboarding.execute({ email: 'kojo@client.example', correlationId: 'u1' });
    const userId = auth.users.get('kojo@client.example')!.id;
    const attempt = t.app.acceptOwnerInvitation.execute({
      authUserId: userId,
      authMethods: ['recovery'],
      fullName: 'Kojo Addo',
      pin: '5821', // Akosua's
      correlationId: 'u2',
    });
    await expect(attempt).rejects.toMatchObject({
      code: 'PIN_IN_USE',
      message: 'This PIN is already in use. Please choose another PIN.',
    });
    await expect(attempt).rejects.not.toMatchObject({ message: expect.stringMatching(/Akosua/) });
    // Weak PINs are refused too.
    await expect(
      t.app.acceptOwnerInvitation.execute({
        authUserId: userId,
        authMethods: ['recovery'],
        fullName: 'Kojo Addo',
        pin: '1234',
        correlationId: 'u3',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const ok = await t.app.acceptOwnerInvitation.execute({
      authUserId: userId,
      authMethods: ['recovery'],
      fullName: 'Kojo Addo',
      pin: '6047',
      correlationId: 'u4',
    });
    expect(ok.device.device.name).toBe('Kojo device 1');
  });

  it('email sign-in link: same answer for any address; lands on device setup', async () => {
    const before = auth.recoveryEmails.length;
    await expect(
      t.app.sendSignInLink.execute({ email: 'Akosua@Client.example', correlationId: 'l1' }),
    ).resolves.toEqual({ ok: true });
    await expect(
      t.app.sendSignInLink.execute({ email: 'nobody@nowhere.example', correlationId: 'l2' }),
    ).resolves.toEqual({ ok: true });
    expect(auth.recoveryEmails.slice(before)[0]).toEqual({
      email: 'akosua@client.example',
      redirectTo: 'https://app.test/device-setup',
    });
  });

  it('registering another personal device needs an email-link session and device management', async () => {
    const userId = auth.users.get('akosua@client.example')!.id;
    const owner = await t.as(userId);
    await expect(t.app.registerPersonalDevice.execute({ ...owner, authMethod: 'pin' })).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
      },
    );
    const second = await t.app.registerPersonalDevice.execute({ ...owner, authMethod: 'email_link' });
    expect(second.device.name).toBe('Akosua device 2');
    const cashier = await t.as(f.authUsers.cashier);
    await expect(
      t.app.registerPersonalDevice.execute({ ...cashier, authMethod: 'email_link' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('expired invitations do nothing', async () => {
    await invite('late@client.example', -1);
    const before = auth.recoveryEmails.length;
    await t.app.startOwnerOnboarding.execute({ email: 'late@client.example', correlationId: 'c5' });
    expect(auth.recoveryEmails.length).toBe(before);
  });
});
