import type { Application, PinHasher, RequestContext } from '@rp/application';
import type { HubPinChangeCommand } from '@rp/contracts';
import { assertAcceptablePin, DomainError } from '@rp/domain';
import type { Database } from '@rp/infrastructure';

/** The cloud calls the hub needs for PINs (see CloudPort). */
export interface CloudPinPort {
  verifyPin(pin: string): Promise<{ staffId: string; pinVersion: number; mustChangePin: boolean }>;
  changePin(cmd: HubPinChangeCommand): Promise<{ pinVersion: number }>;
}

/**
 * Staff PINs on the hub (docs/OFFLINE-AUTHENTICATION.md).
 *
 * The cloud's PIN digests (keyed with the environment-wide secret) never reach a hub. The hub keeps
 * its OWN digest per staff member, keyed with a secret that exists only on this hub, learnt the
 * first time that person signs in on the hub while the cloud is reachable. After that, sign-in works
 * offline with the usual lockouts. A PIN changed in the back office invalidates the hub's copy at
 * the next sync (its pin_version differs), so an old PIN stops working once the hub has synced.
 */
export class HubPinService {
  constructor(
    private readonly db: Database,
    private readonly app: Application,
    private readonly hasher: PinHasher,
    private readonly cloud: CloudPinPort,
    private readonly isOnline: () => boolean,
  ) {}

  /** PIN sign-in on a till connected to the hub. Same result shape as the cloud. */
  async signIn(ctx: RequestContext, pin: string) {
    await this.learn(ctx.principal.restaurantId, pin);
    return this.app.pinSignIn.execute(ctx, pin);
  }

  /**
   * Makes sure the hub knows this PIN if it is valid: unknown PINs are checked with the cloud (its
   * own lockouts apply) while it is reachable. A wrong PIN is left for the local check, which records
   * the failure and answers generically.
   */
  async learn(restaurantId: string, pin: string): Promise<void> {
    if (!/^\d{4,6}$/.test(pin) || !this.isOnline()) return;
    const lookup = this.hasher.lookup(restaurantId, pin);
    const [known] = await this.db.query('select 1 from staff where pin_lookup = $1', [lookup]);
    if (known) return;
    const verified = await this.cloud.verifyPin(pin).catch(() => null);
    if (verified) await this.remember(verified.staffId, lookup, verified.pinVersion, verified.mustChangePin);
  }

  /**
   * A staff member changes their PIN on a hub till. Needs the cloud, so the new PIN works on every
   * till and in the back office; offline the current PIN keeps working.
   */
  async changeOwnPin(ctx: RequestContext, cmd: { currentPin?: string | null; newPin: string }) {
    const staffId = ctx.principal.staffId;
    if (ctx.principal.kind !== 'staff' || !staffId)
      throw new DomainError('FORBIDDEN', 'Only staff members have a PIN');
    assertAcceptablePin(cmd.newPin);
    if (!this.isOnline())
      throw new DomainError(
        'UNAVAILABLE',
        'Changing a PIN needs the internet. Your current PIN still works.',
      );
    const { pinVersion } = await this.cloud.changePin({
      staffId,
      currentPin: cmd.currentPin ?? null,
      newPin: cmd.newPin,
    });
    await this.remember(
      staffId,
      this.hasher.lookup(ctx.principal.restaurantId, cmd.newPin),
      pinVersion,
      false,
    );
    return { ok: true as const };
  }

  private async remember(staffId: string, lookup: string, pinVersion: number, mustChange: boolean) {
    await this.db.transaction(async (sql) => {
      // A digest can only belong to one person: drop a stale copy held by someone else.
      await sql.query('update staff set pin_lookup = null where pin_lookup = $1 and id <> $2', [
        lookup,
        staffId,
      ]);
      await sql.query(
        `update staff set pin_lookup = $2, pin_version = $3, pin_must_change = $4 where id = $1`,
        [staffId, lookup, pinVersion, mustChange],
      );
    });
  }
}
