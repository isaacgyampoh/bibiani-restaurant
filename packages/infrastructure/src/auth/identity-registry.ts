import { randomBytes, randomInt } from 'node:crypto';
import type { IdentityRegistry, SecretGenerator } from '@rp/application';
import type { Database } from '../db/sql';

/** Calls the SECURITY DEFINER pairing and onboarding functions. Runs without a tenant context by design. */
export class PgIdentityRegistry implements IdentityRegistry {
  constructor(private readonly db: Database) {}

  async redeemPairingCode(codeHash: string, now: Date) {
    const [r] = await this.db.query<{
      device_id: string;
      restaurant_id: string;
      branch_id: string;
      kind: string;
      name: string;
      station_id: string | null;
      previous_auth_user_id: string | null;
    }>('select * from app.redeem_pairing_code($1, $2)', [codeHash, now.toISOString()]);
    return r
      ? {
          deviceId: r.device_id,
          restaurantId: r.restaurant_id,
          branchId: r.branch_id,
          kind: r.kind,
          name: r.name,
          stationId: r.station_id,
          previousAuthUserId: r.previous_auth_user_id,
        }
      : null;
  }

  async bindDeviceIdentity(deviceId: string, authUserId: string) {
    await this.db.query('select app.bind_device_identity($1, $2)', [deviceId, authUserId]);
  }

  async createPairingRequest(
    codeHash: string,
    secretHash: string,
    expiresAt: Date,
    now: Date,
    kind: string | null = null,
    replacesSecretHash: string | null = null,
  ) {
    await this.db.query('select app.create_pairing_request_v2($1, $2, $3, $4, $5::device_kind, $6)', [
      codeHash,
      secretHash,
      expiresAt.toISOString(),
      now.toISOString(),
      kind,
      replacesSecretHash,
    ]);
  }

  async approvePairingRequest(
    codeHash: string,
    managerCodeHash: string,
    restaurantId: string,
    deviceId: string,
    staffId: string | null,
    now: Date,
  ) {
    const [r] = await this.db.query<{ status: string }>(
      'select app.approve_pairing_request_v2($1, $2, $3, $4, $5, $6) as status',
      [codeHash, managerCodeHash, restaurantId, deviceId, staffId, now.toISOString()],
    );
    return r?.status ?? 'not_found';
  }

  async collectPairingRequest(secretHash: string, now: Date) {
    const [r] = await this.db.query<{
      status: string;
      device_id: string | null;
      restaurant_id: string;
      branch_id: string;
      kind: string;
      name: string;
      station_id: string | null;
      previous_auth_user_id: string | null;
    }>('select * from app.collect_pairing_request($1, $2)', [secretHash, now.toISOString()]);
    if (!r || r.status === 'expired') return { status: 'expired' as const };
    if (r.status === 'waiting') return { status: 'waiting' as const };
    return {
      status: 'approved' as const,
      device: r.device_id
        ? {
            deviceId: r.device_id,
            restaurantId: r.restaurant_id,
            branchId: r.branch_id,
            kind: r.kind,
            name: r.name,
            stationId: r.station_id,
            previousAuthUserId: r.previous_auth_user_id,
          }
        : null,
    };
  }

  async managersByEmail(email: string) {
    const rows = await this.db.query<{ restaurant_id: string; staff_id: string }>(
      'select * from app.managers_by_email($1)',
      [email],
    );
    return rows.map((r) => ({ restaurantId: r.restaurant_id, staffId: r.staff_id }));
  }

  async findOwnerInvitation(email: string, now: Date) {
    const [r] = await this.db.query<{ id: string; restaurant_id: string; restaurant_name: string }>(
      'select * from app.find_owner_invitation($1, $2)',
      [email, now.toISOString()],
    );
    return r ? { id: r.id, restaurantId: r.restaurant_id, restaurantName: r.restaurant_name } : null;
  }
}

// Unambiguous alphabet (no 0/O, 1/I/L, U): 30 symbols, 8 characters = 30^8 ≈ 6.6e11 codes, valid 10 minutes, single use.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export const cryptoSecrets: SecretGenerator = {
  pairingCode: () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''),
  password: () => randomBytes(32).toString('base64url'),
};
