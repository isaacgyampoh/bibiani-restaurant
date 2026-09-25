import {
  type ConfigEntity,
  ConfigSchemas,
  type ConfigurationView,
  type CreateStaffCommand,
  DELETABLE_CONFIG,
  type PairDeviceCommand,
  type PairDeviceResult,
  type PairingCodeView,
  type UpdateStaffCommand,
} from '@rp/contracts';
import { DomainError, type Permission } from '@rp/domain';
import { authorize, type RequestContext } from '../principal';
import { CommitLog, type Dependencies } from './shared';

const ENTITY_PERMISSION: Record<ConfigEntity, Permission> = {
  restaurant: 'config.manage',
  branch: 'config.manage',
  area: 'config.manage',
  table: 'config.manage',
  station: 'config.manage',
  stationOutput: 'config.manage',
  routingRule: 'menu.manage',
  category: 'menu.manage',
  product: 'menu.manage',
  taxRate: 'menu.manage',
  modifierGroup: 'menu.manage',
  modifier: 'menu.manage',
  branchProduct: 'menu.manage',
  device: 'device.manage',
  role: 'staff.manage',
};

/** Restaurant-wide configuration requires the permission for every branch (a null-branch grant). */
export function authorizeRestaurantWide(ctx: RequestContext, permission: Permission): void {
  const ok = ctx.principal.grants.some((g) => g.branchId === null && g.permissions.has(permission));
  if (!ok) throw new DomainError('FORBIDDEN', 'You do not have permission to do this', { permission });
}

function authorizeEntity(ctx: RequestContext, entity: ConfigEntity, record: Record<string, unknown>): void {
  const permission = ENTITY_PERMISSION[entity];
  const branchId = typeof record.branchId === 'string' ? record.branchId : null;
  if (branchId) authorize(ctx.principal, permission, branchId);
  else authorizeRestaurantWide(ctx, permission);
}

export class GetConfiguration {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext): Promise<ConfigurationView> {
    const allowed = (['config.manage', 'menu.manage', 'device.manage', 'staff.manage'] as const).some((p) =>
      ctx.principal.grants.some((g) => g.permissions.has(p)),
    );
    if (!allowed) throw new DomainError('FORBIDDEN', 'You do not have permission to do this');
    return this.deps.uow.run(ctx.principal.restaurantId, (tx) => tx.read.configuration());
  }
}

/** Create or update one configuration record. Validated, authorized, and audited with before/after. */
export class SaveConfig {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, entity: ConfigEntity, input: unknown): Promise<{ id: string }> {
    const schema = ConfigSchemas[entity];
    if (!schema) throw new DomainError('NOT_FOUND', 'Unknown configuration type');
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', 'Some details are missing or invalid', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const record = parsed.data as Record<string, unknown>;
    authorizeEntity(ctx, entity, record);
    if (entity === 'device' && record.kind === 'printer' && !record.printer && !record.id) {
      throw new DomainError('VALIDATION_FAILED', 'Enter the printer network address');
    }
    const log = new CommitLog(ctx);
    const id = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const key =
        entity === 'branchProduct'
          ? `${record.branchId}:${record.productId}`
          : (record.id as string | undefined);
      const before = key ? await tx.admin.get(entity, key) : null;
      const savedId = await tx.admin.save(entity, record);
      await tx.audit.append({
        branchId: typeof record.branchId === 'string' ? record.branchId : null,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: `config.${entity}.${before ? 'update' : 'create'}`,
        entityType: entity,
        entityId: savedId,
        before,
        after: record,
        correlationId: ctx.correlationId,
      });
      log.add('config.saved', { entity, id: savedId, created: !before });
      return savedId;
    });
    log.flush(this.deps.logger);
    return { id };
  }
}

export class DeleteConfig {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, entity: ConfigEntity, id: string): Promise<{ deleted: boolean }> {
    if (!DELETABLE_CONFIG.includes(entity)) {
      throw new DomainError('VALIDATION_FAILED', 'This item cannot be deleted. Deactivate it instead');
    }
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const before = await tx.admin.get(entity, id);
      if (!before) throw new DomainError('NOT_FOUND', 'Not found');
      authorizeEntity(ctx, entity, { branchId: before.branch_id ?? null });
      const deleted = await tx.admin.delete(entity, id);
      await tx.audit.append({
        branchId: (before.branch_id as string | undefined) ?? null,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: `config.${entity}.delete`,
        entityType: entity,
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      });
      return { deleted };
    });
  }
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------
export class CreateStaff {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, cmd: CreateStaffCommand): Promise<{ staffId: string }> {
    if (cmd.branchId) authorize(ctx.principal, 'staff.manage', cmd.branchId);
    else authorizeRestaurantWide(ctx, 'staff.manage');
    const auth = required(this.deps.auth, 'auth directory');
    const email = cmd.email.trim().toLowerCase();
    const staffId = this.deps.ids.uuid();
    // The login lives in the identity provider; if saving the staff record fails we remove it again.
    const { id: userId } = await auth.createUser({
      email,
      password: cmd.password,
      metadata: { restaurant_id: ctx.principal.restaurantId, staff_id: staffId },
    });
    try {
      await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
        await tx.admin.insertStaff({ id: staffId, userId, displayName: cmd.displayName, email });
        await tx.admin.setStaffRoles(staffId, cmd.roleIds, cmd.branchId ?? null);
        await tx.audit.append({
          branchId: cmd.branchId ?? null,
          actorStaffId: ctx.principal.staffId,
          actorDeviceId: ctx.deviceId,
          action: 'staff.create',
          entityType: 'staff',
          entityId: staffId,
          after: {
            displayName: cmd.displayName,
            email,
            roleIds: cmd.roleIds,
            branchId: cmd.branchId ?? null,
          },
          correlationId: ctx.correlationId,
        });
      });
    } catch (error) {
      await auth.deleteUser(userId).catch(() => undefined);
      throw error;
    }
    return { staffId };
  }
}

export class UpdateStaff {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, staffId: string, cmd: UpdateStaffCommand): Promise<{ ok: true }> {
    authorizeRestaurantWide(ctx, 'staff.manage');
    if (staffId === ctx.principal.staffId && (cmd.isActive === false || cmd.roleIds)) {
      throw new DomainError('VALIDATION_FAILED', 'You cannot change your own access');
    }
    await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const before = await tx.admin.staff(staffId);
      if (!before) throw new DomainError('NOT_FOUND', 'Staff member not found');
      await tx.admin.updateStaff(staffId, { displayName: cmd.displayName, isActive: cmd.isActive });
      if (cmd.roleIds) await tx.admin.setStaffRoles(staffId, cmd.roleIds, cmd.branchId ?? null);
      if (cmd.password && before.userId)
        await required(this.deps.auth, 'auth directory').updatePassword(before.userId, cmd.password);
      await tx.audit.append({
        branchId: null,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'staff.update',
        entityType: 'staff',
        entityId: staffId,
        before,
        after: { ...cmd, password: cmd.password ? '(changed)' : undefined },
        correlationId: ctx.correlationId,
      });
    });
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Device pairing
// ---------------------------------------------------------------------------
const PAIRABLE = new Set(['pos', 'kds', 'customer_display', 'print_agent']);
const PAIRING_TTL_MS = 10 * 60 * 1000;

export class CreatePairingCode {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, deviceId: string): Promise<PairingCodeView> {
    const secrets = required(this.deps.secrets, 'secret generator');
    const code = secrets.pairingCode();
    const expiresAt = new Date(this.deps.clock.now().getTime() + PAIRING_TTL_MS);
    await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const device = await tx.admin.device(deviceId);
      if (!device) throw new DomainError('NOT_FOUND', 'Device not found');
      authorize(ctx.principal, 'device.manage', device.branchId);
      if (!device.isActive) throw new DomainError('VALIDATION_FAILED', 'This device is deactivated');
      if (!PAIRABLE.has(device.kind))
        throw new DomainError('VALIDATION_FAILED', 'Printers are driven by a print agent and are not paired');
      await tx.admin.insertPairingCode({
        deviceId,
        codeHash: this.deps.fingerprint.of({ pairing: code }),
        expiresAt,
        createdByStaffId: ctx.principal.staffId,
      });
      await tx.audit.append({
        branchId: device.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'device.pairing_code_created',
        entityType: 'device',
        entityId: deviceId,
        after: { expiresAt: expiresAt.toISOString() },
        correlationId: ctx.correlationId,
      });
    });
    return { deviceId, code, expiresAt: expiresAt.toISOString() };
  }
}

/**
 * Public step, done ON the device: exchange a one-time code for the device's
 * own login. A new identity is created for every pairing; any previous
 * identity of that device is deleted, which revokes the old installation.
 * No shared or embedded password ever exists.
 */
export class PairDevice {
  constructor(private readonly deps: Dependencies) {}

  async execute(cmd: PairDeviceCommand, correlationId: string): Promise<PairDeviceResult> {
    const identity = required(this.deps.identity, 'identity registry');
    const auth = required(this.deps.auth, 'auth directory');
    const secrets = required(this.deps.secrets, 'secret generator');
    const now = this.deps.clock.now();
    const code = cmd.code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const device = await identity.redeemPairingCode(this.deps.fingerprint.of({ pairing: code }), now);
    if (!device) {
      this.deps.logger.warn('device.pairing_rejected', { correlationId });
      throw new DomainError(
        'PAIRING_CODE_INVALID',
        'That code is not valid or has expired. Ask a manager for a new one',
      );
    }

    const email = `device-${device.deviceId}-${secrets.pairingCode().toLowerCase()}@${this.deps.deviceAccountDomain ?? 'devices.example.com'}`;
    const password = secrets.password();
    const { id: authUserId } = await auth.createUser({
      email,
      password,
      metadata: { device_id: device.deviceId, restaurant_id: device.restaurantId, kind: device.kind },
    });
    try {
      await identity.bindDeviceIdentity(device.deviceId, authUserId);
      const session = await auth.signIn(email, password);
      if (device.previousAuthUserId) await auth.deleteUser(device.previousAuthUserId).catch(() => undefined);
      await this.deps.uow.run(device.restaurantId, async (tx) => {
        await tx.devices.appendEvent(device.deviceId, 'paired', {
          replacedPreviousIdentity: Boolean(device.previousAuthUserId),
        });
        await tx.audit.append({
          branchId: device.branchId,
          actorStaffId: null,
          actorDeviceId: device.deviceId,
          action: 'device.paired',
          entityType: 'device',
          entityId: device.deviceId,
          after: { kind: device.kind, name: device.name },
          correlationId,
        });
      });
      this.deps.logger.info('device.paired', {
        correlationId,
        deviceId: device.deviceId,
        restaurantId: device.restaurantId,
      });
      return {
        device: {
          id: device.deviceId,
          name: device.name,
          kind: device.kind,
          branchId: device.branchId,
          stationId: device.stationId,
          restaurantId: device.restaurantId,
        },
        session,
      };
    } catch (error) {
      await auth.deleteUser(authUserId).catch(() => undefined);
      throw error;
    }
  }
}

/** Ends a device's access immediately (API) and deletes its login. It can be paired again later. */
export class RevokeDevice {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, deviceId: string): Promise<{ ok: true }> {
    const previous = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const device = await tx.admin.device(deviceId);
      if (!device) throw new DomainError('NOT_FOUND', 'Device not found');
      authorize(ctx.principal, 'device.manage', device.branchId);
      await tx.admin.unbindDeviceIdentity(deviceId);
      await tx.audit.append({
        branchId: device.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'device.revoked',
        entityType: 'device',
        entityId: deviceId,
        before: { paired: Boolean(device.authUserId) },
        after: { paired: false },
        correlationId: ctx.correlationId,
      });
      return device.authUserId;
    });
    if (previous && this.deps.auth) await this.deps.auth.deleteUser(previous).catch(() => undefined);
    return { ok: true };
  }
}

function required<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`Application was started without a ${name}`);
  return value;
}
