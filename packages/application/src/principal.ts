import { DEVICE_PERMISSIONS, type DeviceKind, DomainError, type Permission } from '@rp/domain';

/**
 * Who is calling, resolved server-side from a verified access token and the
 * membership tables. Never built from client-supplied tenant ids or permissions.
 */
export interface Principal {
  kind: 'staff' | 'device';
  authUserId: string;
  restaurantId: string;
  staffId: string | null;
  deviceId: string | null;
  deviceKind: DeviceKind | null;
  deviceStationId: string | null;
  /** branchId null = grant applies to every branch of the restaurant. */
  grants: readonly { branchId: string | null; permissions: ReadonlySet<Permission> }[];
  /** Branches that belong to this principal's restaurant. Every branch-scoped check is limited to these. */
  restaurantBranchIds: ReadonlySet<string>;
}

export function devicePrincipal(input: {
  authUserId: string;
  restaurantId: string;
  deviceId: string;
  deviceKind: DeviceKind;
  branchId: string;
  stationId: string | null;
}): Principal {
  // A device only ever works in its own branch.
  return {
    kind: 'device',
    authUserId: input.authUserId,
    restaurantId: input.restaurantId,
    staffId: null,
    deviceId: input.deviceId,
    deviceKind: input.deviceKind,
    deviceStationId: input.stationId,
    grants: [{ branchId: input.branchId, permissions: new Set(DEVICE_PERMISSIONS[input.deviceKind]) }],
    restaurantBranchIds: new Set([input.branchId]),
  };
}

export function can(principal: Principal, permission: Permission, branchId: string): boolean {
  if (!principal.restaurantBranchIds.has(branchId)) return false;
  return principal.grants.some(
    (g) => (g.branchId === null || g.branchId === branchId) && g.permissions.has(permission),
  );
}

export function authorize(principal: Principal, permission: Permission, branchId: string): void {
  if (!can(principal, permission, branchId)) {
    throw new DomainError('FORBIDDEN', 'You do not have permission to do this', { permission, branchId });
  }
}

/** Per-request context passed to every use case. */
export interface RequestContext {
  principal: Principal;
  correlationId: string;
  /** Device the staff member is operating (validated server-side), or the device principal itself. */
  deviceId: string | null;
}
