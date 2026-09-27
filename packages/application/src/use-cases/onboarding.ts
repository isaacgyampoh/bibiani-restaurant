import type { PairDeviceResult } from '@rp/contracts';
import { assertAcceptablePin, DomainError } from '@rp/domain';
import { registerPersonalDevice } from './administration';
import { assertPinFree } from './pins';
import type { Dependencies } from './shared';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/**
 * Email-link sign-ins: the only proof that someone controls the address. PIN sessions are issued as
 * magic-link sessions, so "otp"/"magiclink" do NOT count as proof.
 */
const EMAIL_PROOF = new Set(['recovery', 'invite']);

/**
 * Step 1 (public): the owner enters their email on the welcome screen. If an open invitation exists
 * for it, a single-use verification link is emailed. The answer is the same either way, so the
 * screen cannot be used to find out which emails are invited. No password is created or shared:
 * the login gets a random password nobody knows. After verification the owner chooses a PIN and
 * signs in with it on their registered devices; the email stays their recovery channel.
 */
export class StartOwnerOnboarding {
  constructor(private readonly deps: Dependencies) {}

  async execute(input: { email: string; correlationId: string }): Promise<{ ok: true }> {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 200)
      throw new DomainError('VALIDATION_FAILED', 'Enter a valid email address', { field: 'email' });
    const identity = this.deps.identity;
    const auth = this.deps.auth;
    const secrets = this.deps.secrets;
    if (!identity || !auth || !secrets || !this.deps.publicUrl)
      throw new DomainError('UNAVAILABLE', 'Owner sign-up is not set up on this server');
    const invitation = await identity.findOwnerInvitation(email, this.deps.clock.now());
    if (!invitation) {
      this.deps.logger.info('owner_onboarding.no_invitation', { correlationId: input.correlationId });
      return { ok: true };
    }
    try {
      await auth.createUser({ email, password: secrets.password(), metadata: { onboarding: 'owner' } });
    } catch (error) {
      // Already has a login (e.g. asked for the email twice): the link below is still what they need.
      if (!(error instanceof DomainError && /already exists/i.test(error.message))) throw error;
    }
    try {
      await auth.sendRecoveryEmail(email, `${this.deps.publicUrl}/welcome/verify`);
    } catch (error) {
      // Same answer either way (a visible error would reveal that this email is invited). The
      // operator sees this in the logs; the usual cause is the email provider's sending limit.
      this.deps.logger.error('owner_onboarding.email_failed', {
        correlationId: input.correlationId,
        restaurantId: invitation.restaurantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: true };
    }
    await this.deps.uow.run(invitation.restaurantId, (tx) =>
      tx.audit.append({
        branchId: null,
        actorStaffId: null,
        actorDeviceId: null,
        action: 'owner.verification_sent',
        entityType: 'owner_invitation',
        entityId: invitation.id,
        after: { email },
        correlationId: input.correlationId,
      }),
    );
    return { ok: true };
  }
}

/**
 * Step 2 (after the email link): the verified login becomes the restaurant's Owner. Checks that
 * the session came from an email link and that the login's email matches an open invitation.
 * Idempotent: repeating it changes nothing.
 */
export class AcceptOwnerInvitation {
  constructor(private readonly deps: Dependencies) {}

  async execute(input: {
    authUserId: string;
    authMethods: readonly string[];
    fullName: string;
    /** The owner's own PIN, chosen now (4 to 6 digits, unique in the restaurant). */
    pin: string;
    correlationId: string;
  }): Promise<{ restaurantId: string; restaurantName: string; device: PairDeviceResult }> {
    const identity = this.deps.identity;
    const auth = this.deps.auth;
    if (!identity || !auth)
      throw new DomainError('UNAVAILABLE', 'Owner sign-up is not set up on this server');
    const fullName = input.fullName.trim().replace(/\s+/g, ' ');
    if (fullName.length < 2 || fullName.length > 80)
      throw new DomainError('VALIDATION_FAILED', 'Enter your full name', { field: 'fullName' });
    assertAcceptablePin(input.pin);
    const pinHasher = this.deps.pinHasher;
    if (!pinHasher) throw new DomainError('UNAVAILABLE', 'PIN sign-in is not set up on this server');
    if (!input.authMethods.some((m) => EMAIL_PROOF.has(m)))
      throw new DomainError('FORBIDDEN', 'Open the link from your email to finish setting up');
    const { email } = await auth.getUser(input.authUserId);
    const now = this.deps.clock.now();
    const invitation = email ? await identity.findOwnerInvitation(email, now) : null;
    if (!email || !invitation)
      throw new DomainError(
        'FORBIDDEN',
        'This email has no open invitation. Ask your MY FOOD contact for one.',
      );

    const now2 = this.deps.clock.now();
    const staffId = await this.deps.uow.run(invitation.restaurantId, async (tx) => {
      const ownerRole = await tx.admin.systemRoleId('Owner');
      if (!ownerRole) throw new DomainError('UNAVAILABLE', 'This restaurant has no Owner role');
      let staffId = await tx.admin.staffIdForUser(input.authUserId);
      if (!staffId) {
        staffId = this.deps.ids.uuid();
        await tx.admin.insertStaff({ id: staffId, userId: input.authUserId, displayName: fullName, email });
      }
      await tx.admin.setStaffRoles(staffId, [ownerRole], null);
      // The owner's PIN: unique in the restaurant (the answer never says whose PIN it is).
      const lookup = pinHasher.lookup(invitation.restaurantId, input.pin);
      await assertPinFree(tx, lookup, staffId);
      await tx.pins.setPin(staffId, lookup, false, now2);
      await tx.pins.activate(staffId, now2);
      await tx.admin.acceptOwnerInvitation(invitation.id, staffId, now);
      await tx.audit.append({
        branchId: null,
        actorStaffId: staffId,
        actorDeviceId: null,
        action: 'owner.onboarded',
        entityType: 'staff',
        entityId: staffId,
        after: { displayName: fullName, email, role: 'Owner', pinSet: true },
        correlationId: input.correlationId,
      });
      return staffId;
    });
    // This browser becomes the owner's first personal device: from now on they sign in with the PIN.
    const device = await registerPersonalDevice(this.deps, {
      restaurantId: invitation.restaurantId,
      staffId,
      displayName: fullName,
      correlationId: input.correlationId,
    });
    this.deps.logger.info('owner_onboarding.accepted', {
      correlationId: input.correlationId,
      restaurantId: invitation.restaurantId,
    });
    return { restaurantId: invitation.restaurantId, restaurantName: invitation.restaurantName, device };
  }
}

/**
 * "Email me a sign-in link" (public): for owners and managers on a device that is not set up for
 * PIN sign-in yet, or who forgot their PIN. The same answer for every address, whether or not it
 * belongs to anyone. The link lands on /device-setup, where they register the device and, if
 * needed, choose a new PIN. The existing PIN is never sent or shown.
 */
export class SendSignInLink {
  constructor(private readonly deps: Dependencies) {}

  async execute(input: { email: string; correlationId: string }): Promise<{ ok: true }> {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 200)
      throw new DomainError('VALIDATION_FAILED', 'Enter a valid email address', { field: 'email' });
    if (!this.deps.auth || !this.deps.publicUrl)
      throw new DomainError('UNAVAILABLE', 'Email sign-in is not set up on this server');
    try {
      // The identity provider sends nothing to addresses without a login.
      await this.deps.auth.sendRecoveryEmail(email, `${this.deps.publicUrl}/device-setup`);
    } catch (error) {
      this.deps.logger.error('sign_in_link.email_failed', {
        correlationId: input.correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { ok: true };
  }
}
