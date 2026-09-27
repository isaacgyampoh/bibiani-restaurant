import { assertAcceptablePin, DomainError, PIN_POLICY, pinLockedUntil } from '@rp/domain';
import type { AuthSession, PinHasher, PinStaff, Repositories } from '../ports';
import { authorize, type RequestContext } from '../principal';
import { authorizeRestaurantWide } from './administration';
import type { Dependencies } from './shared';

/**
 * Staff PINs.
 *  - A PIN unlocks a staff session ONLY on a registered till (the caller is a paired POS device).
 *  - Only a keyed digest is stored; PINs are never returned, logged or shown.
 *  - A wrong or unknown PIN gets the same answer, and repeated failures lock the till (and, for a
 *    spread-out attack, all tills of the restaurant) for a while. Every attempt is recorded.
 *  - The owner assigns a first PIN; the staff member replaces it on first sign-in (activation).
 */
const GENERIC = 'PIN not recognised';

function hasher(deps: Dependencies): PinHasher {
  if (!deps.pinHasher) throw new DomainError('UNAVAILABLE', 'PIN sign-in is not set up on this server');
  return deps.pinHasher;
}

export async function assertPinFree(tx: Repositories, lookup: string, staffId: string): Promise<void> {
  const owner = await tx.pins.staffByLookup(lookup);
  // Never say whose PIN it is.
  if (owner && owner.staffId !== staffId)
    throw new DomainError('PIN_IN_USE', 'This PIN is already in use. Please choose another PIN.', {
      field: 'pin',
    });
}

function audit(tx: Repositories, ctx: RequestContext, action: string, staffId: string, after: unknown = {}) {
  return tx.audit.append({
    branchId: null,
    actorStaffId: ctx.principal.staffId,
    actorDeviceId: ctx.deviceId,
    action,
    entityType: 'staff',
    entityId: staffId,
    after,
    correlationId: ctx.correlationId,
  });
}

export interface PinSignInResult {
  session: AuthSession;
  displayName: string;
  mustChangePin: boolean;
}

/**
 * Checks a PIN typed on a registered device (a till, or an in-store hub asking on a till's behalf).
 * Lockouts and attempts are recorded against that device. Returns who the PIN belongs to, or throws
 * the same generic error for wrong and unknown PINs.
 */
async function checkPin(
  deps: Dependencies,
  ctx: RequestContext,
  deviceId: string,
  pin: string,
): Promise<PinStaff> {
  const restaurantId = ctx.principal.restaurantId;
  const now = deps.clock.now();
  const since = new Date(now.getTime() - PIN_POLICY.windowSeconds * 1000);
  const lookup = /^\d{4,6}$/.test(pin) ? hasher(deps).lookup(restaurantId, pin) : null;

  // Decide and record inside one transaction; failures are committed, then reported.
  const outcome = await deps.uow.run(restaurantId, async (tx) => {
    const locked = pinLockedUntil(
      await tx.pins.failures({ deviceId }, since),
      await tx.pins.failures('restaurant', since),
      now,
    );
    if (locked) return { kind: 'locked' as const, until: locked.until, scope: locked.scope };
    const staff = lookup ? await tx.pins.staffByLookup(lookup) : null;
    const ok = !!staff && staff.isActive && !!staff.userId;
    await tx.pins.recordAttempt({ deviceId, staffId: ok ? staff!.staffId : null, succeeded: ok, at: now });
    if (!ok) {
      const after = pinLockedUntil(
        await tx.pins.failures({ deviceId }, since),
        await tx.pins.failures('restaurant', since),
        now,
      );
      if (after)
        await tx.audit.append({
          branchId: null,
          actorStaffId: null,
          actorDeviceId: deviceId,
          action: 'security.pin_lockout',
          entityType: 'device',
          entityId: deviceId,
          after: { scope: after.scope, until: after.until.toISOString() },
          correlationId: ctx.correlationId,
        });
      return { kind: 'failed' as const };
    }
    await audit(tx, ctx, 'staff.pin_sign_in', staff!.staffId, { deviceId });
    return { kind: 'ok' as const, staff: staff! };
  });

  if (outcome.kind === 'locked') {
    const minutes = Math.max(1, Math.ceil((outcome.until.getTime() - now.getTime()) / 60_000));
    deps.logger.warn('security.pin_locked', { deviceId, scope: outcome.scope });
    throw new DomainError(
      'RATE_LIMITED',
      `Too many wrong PINs. PIN sign-in is locked for ${minutes} minute${minutes === 1 ? '' : 's'}. A manager can reset your PIN, or wait and try again.`,
    );
  }
  if (outcome.kind === 'failed') {
    deps.logger.warn('security.pin_failed', { deviceId, correlationId: ctx.correlationId });
    throw new DomainError('PIN_INVALID', GENERIC);
  }
  return outcome.staff;
}

export class PinSignIn {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, pin: string): Promise<PinSignInResult> {
    const p = ctx.principal;
    if (p.kind !== 'device' || p.deviceKind !== 'pos' || !p.deviceId)
      throw new DomainError('FORBIDDEN', 'PIN sign-in works only on a registered till');
    const staff = await checkPin(this.deps, ctx, p.deviceId, pin);
    const session = await this.deps.auth!.createSession(staff.userId!);
    const deviceId = p.deviceId;
    if (session.sessionId)
      await this.deps.uow.run(p.restaurantId, (tx) =>
        tx.pins.bindSession(session.sessionId!, staff.staffId, deviceId, this.deps.clock.now()),
      );
    return { session, displayName: staff.displayName, mustChangePin: staff.mustChange };
  }
}

/**
 * Sets a staff member's own PIN. `currentPin` is required unless the PIN must be replaced (first
 * sign-in, owner reset) or the change comes from a recovery email link.
 */
async function changePin(
  deps: Dependencies,
  ctx: RequestContext,
  staffId: string,
  cmd: { currentPin?: string | null; newPin: string },
  via: { emailLink: boolean; hubDeviceId?: string },
): Promise<{ pinSetAt: string; pinVersion: number }> {
  assertAcceptablePin(cmd.newPin);
  const h = hasher(deps);
  const now = deps.clock.now();
  const restaurantId = ctx.principal.restaurantId;
  const pinVersion = await deps.uow.run(restaurantId, async (tx) => {
    const me = await tx.pins.staffById(staffId);
    if (!me || !me.isActive) throw new DomainError('NOT_FOUND', 'Staff member not found');
    if (me.hasPin && !me.mustChange && !via.emailLink) {
      const owner = cmd.currentPin
        ? await tx.pins.staffByLookup(h.lookup(restaurantId, cmd.currentPin))
        : null;
      if (owner?.staffId !== me.staffId)
        throw new DomainError('VALIDATION_FAILED', 'Your current PIN is not correct', {
          field: 'currentPin',
        });
    }
    const lookup = h.lookup(restaurantId, cmd.newPin);
    await assertPinFree(tx, lookup, me.staffId);
    await tx.pins.setPin(me.staffId, lookup, false, now);
    await tx.pins.activate(me.staffId, now);
    await audit(tx, ctx, me.mustChange ? 'staff.pin_activated' : 'staff.pin_changed', me.staffId, {
      via: via.emailLink ? 'email_link' : me.mustChange ? 'first_sign_in' : 'current_pin',
      ...(via.hubDeviceId ? { hubDeviceId: via.hubDeviceId } : {}),
    });
    return me.pinVersion + 1;
  });
  return { pinSetAt: now.toISOString(), pinVersion };
}

/**
 * A staff member sets their own PIN: on first sign-in (activation), after an owner reset, from a
 * recovery email link, or later with their current PIN. The previous PIN stops working at once.
 */
export class ChangeOwnPin {
  constructor(private readonly deps: Dependencies) {}

  async execute(
    ctx: RequestContext,
    cmd: { currentPin?: string | null; newPin: string },
  ): Promise<{ ok: true }> {
    const p = ctx.principal;
    if (p.kind !== 'staff' || !p.staffId) throw new DomainError('FORBIDDEN', 'Only staff members have a PIN');
    await changePin(this.deps, ctx, p.staffId, cmd, { emailLink: ctx.authMethod === 'email_link' });
    return { ok: true };
  }
}

function hubDevice(ctx: RequestContext): string {
  const p = ctx.principal;
  if (p.kind !== 'device' || p.deviceKind !== 'hub' || !p.deviceId)
    throw new DomainError('FORBIDDEN', 'Only a paired MY FOOD hub can do this');
  authorize(p, 'hub.sync', p.grants[0]?.branchId ?? '');
  return p.deviceId;
}

/**
 * An in-store hub asks whether a PIN typed on one of its tills is valid, so it can keep its own
 * copy for offline sign-in (docs/OFFLINE-AUTHENTICATION.md). Same lockouts as a till; the answer
 * carries who it is and when the PIN was set, never the PIN or its digest.
 */
export class VerifyPinForHub {
  constructor(private readonly deps: Dependencies) {}

  async execute(
    ctx: RequestContext,
    pin: string,
  ): Promise<{ staffId: string; pinVersion: number; mustChangePin: boolean }> {
    const staff = await checkPin(this.deps, ctx, hubDevice(ctx), pin);
    return { staffId: staff.staffId, pinVersion: staff.pinVersion, mustChangePin: staff.mustChange };
  }
}

/** A PIN change made on a hub till, forwarded so the new PIN works everywhere. Audited with the hub. */
export class ChangePinFromHub {
  constructor(private readonly deps: Dependencies) {}

  async execute(
    ctx: RequestContext,
    cmd: { staffId: string; currentPin?: string | null; newPin: string },
  ): Promise<{ pinSetAt: string; pinVersion: number }> {
    const hubDeviceId = hubDevice(ctx);
    return changePin(this.deps, ctx, cmd.staffId, cmd, { emailLink: false, hubDeviceId });
  }
}

/** Owner assigns (or resets) a staff member's PIN. The staff member must replace it on next sign-in. */
export class AssignStaffPin {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, staffId: string, pin: string): Promise<{ ok: true }> {
    authorizeRestaurantWide(ctx, 'staff.manage');
    assertAcceptablePin(pin);
    const h = hasher(this.deps);
    const now = this.deps.clock.now();
    await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const staff = await tx.pins.staffById(staffId);
      if (!staff) throw new DomainError('NOT_FOUND', 'Staff member not found');
      const lookup = h.lookup(ctx.principal.restaurantId, pin);
      await assertPinFree(tx, lookup, staffId);
      await tx.pins.setPin(staffId, lookup, true, now);
      await audit(tx, ctx, staff.hasPin ? 'staff.pin_reset' : 'staff.pin_assigned', staffId);
    });
    return { ok: true };
  }
}

/**
 * "Forgot PIN" at a till: emails a single-use link to the staff member's registered address. The
 * answer is the same whether or not the email belongs to a staff member of this restaurant.
 */
export class RequestPinRecovery {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, email: string): Promise<{ ok: true }> {
    const p = ctx.principal;
    if (p.kind !== 'device' || p.deviceKind !== 'pos')
      throw new DomainError('FORBIDDEN', 'PIN recovery starts from a registered till');
    const staff = await this.deps.uow.run(p.restaurantId, (tx) => tx.pins.staffByEmail(email.trim()));
    if (staff?.isActive && staff.email && this.deps.publicUrl) {
      await this.deps
        .auth!.sendRecoveryEmail(staff.email, `${this.deps.publicUrl}/reset-pin`)
        .catch((e: unknown) => this.deps.logger.warn('pin.recovery_email_failed', { error: String(e) }));
      await this.deps.uow.run(p.restaurantId, (tx) =>
        audit(tx, ctx, 'staff.pin_recovery_requested', staff.staffId),
      );
    }
    return { ok: true };
  }
}
