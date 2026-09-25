import { randomBytes, randomInt } from 'node:crypto';
import type { IdentityRegistry, SecretGenerator } from '@rp/application';
import type { Database } from '../db/sql';

/** Calls the two SECURITY DEFINER pairing functions. Runs without a tenant context by design. */
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
}

// Unambiguous alphabet (no 0/O, 1/I/L, U): 30 symbols, 8 characters = 30^8 ≈ 6.6e11 codes, valid 10 minutes, single use.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export const cryptoSecrets: SecretGenerator = {
  pairingCode: () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''),
  password: () => randomBytes(32).toString('base64url'),
};
