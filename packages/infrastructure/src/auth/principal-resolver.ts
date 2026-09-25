import { devicePrincipal, type Principal } from '@rp/application';
import type { DeviceKind, Permission } from '@rp/domain';
import type { Database } from '../db/sql';

export type ResolveResult =
  | { ok: true; principal: Principal; displayName: string }
  | { ok: false; reason: 'no_membership' | 'restaurant_required' | 'not_a_member' };

interface IdentityRow {
  kind: 'staff' | 'device';
  restaurant_id: string;
  staff_id: string | null;
  device_id: string | null;
  device_kind: DeviceKind | null;
  branch_id: string | null;
  station_id: string | null;
  display_name: string;
}

/**
 * Maps a verified auth user to a Principal. The cross-tenant lookup happens
 * inside narrowly-scoped SECURITY DEFINER functions (migration 1000), so the
 * API's own database login never needs table privileges outside RLS.
 */
export class PgPrincipalResolver {
  constructor(private readonly db: Database) {}

  async resolve(authUserId: string, requestedRestaurantId: string | null): Promise<ResolveResult> {
    const rows = await this.db.query<IdentityRow>('select * from app.identity_for_auth_user($1)', [
      authUserId,
    ]);
    if (rows.length === 0) return { ok: false, reason: 'no_membership' };

    const candidates = requestedRestaurantId
      ? rows.filter((r) => r.restaurant_id === requestedRestaurantId)
      : rows;
    if (candidates.length === 0) return { ok: false, reason: 'not_a_member' };
    if (candidates.length > 1) return { ok: false, reason: 'restaurant_required' };
    const identity = candidates[0]!;

    if (identity.kind === 'device') {
      return {
        ok: true,
        displayName: identity.display_name,
        principal: devicePrincipal({
          authUserId,
          restaurantId: identity.restaurant_id,
          deviceId: identity.device_id!,
          deviceKind: identity.device_kind!,
          branchId: identity.branch_id!,
          stationId: identity.station_id,
        }),
      };
    }
    const [grants, branches] = await Promise.all([
      this.db.query<{ branch_id: string | null; permissions: Permission[] }>(
        'select * from app.staff_grants($1)',
        [identity.staff_id],
      ),
      this.db.query<{ branch_id: string }>('select branch_id from app.restaurant_branch_ids($1)', [
        identity.restaurant_id,
      ]),
    ]);
    return {
      ok: true,
      displayName: identity.display_name,
      principal: {
        kind: 'staff',
        authUserId,
        restaurantId: identity.restaurant_id,
        staffId: identity.staff_id,
        deviceId: null,
        deviceKind: null,
        deviceStationId: null,
        grants: grants.map((g) => ({ branchId: g.branch_id, permissions: new Set(g.permissions) })),
        restaurantBranchIds: new Set(branches.map((b) => b.branch_id)),
      },
    };
  }

  /** A staff member may name the POS/KDS they are using; accept it only if it is an active device of their restaurant. */
  async validateOperatingDevice(restaurantId: string, deviceId: string): Promise<boolean> {
    const [row] = await this.db.query<{ ok: boolean }>('select app.device_belongs_to($1, $2) as ok', [
      restaurantId,
      deviceId,
    ]);
    return row?.ok === true;
  }
}
