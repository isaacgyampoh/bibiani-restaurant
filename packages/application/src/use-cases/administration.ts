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
import { assertAcceptablePin, DomainError, type Permission } from '@rp/domain';
import type { IdentityRegistry, Repositories } from '../ports';
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
    const config = await this.deps.uow.run(ctx.principal.restaurantId, (tx) => tx.read.configuration());
    const images = this.deps.images;
    return {
      ...config,
      products: (config.products as Record<string, unknown>[]).map((p) => ({
        ...p,
        imageUrl: typeof p.imagePath === 'string' && images ? images.publicUrl(p.imagePath) : null,
        thumbUrl:
          images && typeof (p.imageThumbPath ?? p.imagePath) === 'string'
            ? images.publicUrl(String(p.imageThumbPath ?? p.imagePath))
            : null,
      })),
    };
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
      if (entity === 'device' && record.isActive === false && typeof record.branchId === 'string')
        await releaseBranchFromHub(tx, ctx, record.branchId, savedId, 'The hub was turned off');
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
    if (cmd.pin) assertAcceptablePin(cmd.pin);
    // Without a back-office password the login gets a random one nobody knows (PIN-only staff).
    const password = cmd.password ?? required(this.deps.secrets, 'secret generator').password();
    const { id: userId } = await auth.createUser({
      email,
      password,
      metadata: { restaurant_id: ctx.principal.restaurantId, staff_id: staffId },
    });
    try {
      await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
        await tx.admin.insertStaff({ id: staffId, userId, displayName: cmd.displayName, email });
        await tx.admin.setStaffRoles(staffId, cmd.roleIds, cmd.branchId ?? null);
        if (cmd.pin) {
          const lookup = required(this.deps.pinHasher, 'PIN hasher').lookup(
            ctx.principal.restaurantId,
            cmd.pin,
          );
          const taken = await tx.pins.staffByLookup(lookup);
          if (taken)
            throw new DomainError('PIN_IN_USE', 'This PIN is already in use. Please choose another PIN.', {
              field: 'pin',
            });
          await tx.pins.setPin(staffId, lookup, true, this.deps.clock.now());
        }
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
            pinAssigned: Boolean(cmd.pin),
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
const PAIRABLE = new Set(['pos', 'kds', 'customer_display', 'print_agent', 'hub']);
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

    return completePairing(this.deps, device, correlationId);
  }
}

type RedeemedDevice = NonNullable<Awaited<ReturnType<IdentityRegistry['redeemPairingCode']>>>;

/**
 * The second half of every pairing (manager-issued code or device-shown code): a new login for
 * the device, bound to its record; any previous login of that device is deleted (the old
 * installation stops working). Audited as `device.paired`.
 */
export async function completePairing(
  deps: Dependencies,
  device: RedeemedDevice,
  correlationId: string,
): Promise<PairDeviceResult> {
  const identity = required(deps.identity, 'identity registry');
  const auth = required(deps.auth, 'auth directory');
  const secrets = required(deps.secrets, 'secret generator');
  const email = `device-${device.deviceId}-${secrets.pairingCode().toLowerCase()}@${deps.deviceAccountDomain ?? 'devices.example.com'}`;
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
    await deps.uow.run(device.restaurantId, async (tx) => {
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
    deps.logger.info('device.paired', {
      correlationId,
      deviceId: device.deviceId,
      restaurantId: device.restaurantId,
    });
    return {
      device: {
        id: device.deviceId,
        name: device.name,
        kind: device.kind as PairDeviceResult['device']['kind'],
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

const REQUEST_TTL_MS = 10 * 60_000;
const formatCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;
const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Device-initiated pairing, step 1 (public, on the device): a display code for the manager and a
 * secret the device keeps in memory. Only hashes are stored.
 */
export class RequestDevicePairing {
  constructor(private readonly deps: Dependencies) {}

  /**
   * `kind`: set by programs that can only be one kind of device (MY FOOD Printing: print_agent; MY
   * FOOD Hub: hub). `replaces`: the secret of this screen's previous code, which stops working now,
   * so a screen has one live code at a time.
   */
  async execute(
    input: { kind?: 'print_agent' | 'hub' | null; replaces?: string | null } = {},
  ): Promise<{ code: string; secret: string; expiresAt: string }> {
    const identity = required(this.deps.identity, 'identity registry');
    const secrets = required(this.deps.secrets, 'secret generator');
    const now = this.deps.clock.now();
    const code = secrets.pairingCode();
    const secret = secrets.password();
    const expiresAt = new Date(now.getTime() + REQUEST_TTL_MS);
    await identity.createPairingRequest(
      this.deps.fingerprint.of({ pairingRequest: code }),
      this.deps.fingerprint.of({ pairingSecret: secret }),
      expiresAt,
      now,
      input.kind ?? null,
      input.replaces ? this.deps.fingerprint.of({ pairingSecret: input.replaces }) : null,
    );
    return { code: formatCode(code), secret, expiresAt: expiresAt.toISOString() };
  }
}

const KIND_LABEL: Record<string, string> = {
  print_agent: 'a print agent (for example PRINT-AGENT-01)',
  hub: 'the MY FOOD Hub device',
};

/** What went wrong with a code, in words the manager can act on. */
export function pairingRefusal(status: string, deviceName: string): string {
  if (status.startsWith('wrong_kind:')) {
    const kind = status.slice('wrong_kind:'.length);
    const program =
      kind === 'print_agent' ? 'MY FOOD Printing' : kind === 'hub' ? 'MY FOOD Hub' : 'this program';
    return `This code comes from ${program}, which can only be paired as ${KIND_LABEL[kind] ?? kind}, not as ${deviceName}. Nothing was changed. Press "Enter code from device" on ${KIND_LABEL[kind] ?? kind} and type the code there.`;
  }
  switch (status) {
    case 'expired':
      return 'That pairing code has expired. The device now shows a new code: enter that one.';
    case 'already_used':
      return 'That pairing code has already been used for another device. If this device still needs pairing, enter the code it shows now.';
    case 'replaced':
      return 'The device has shown a newer code since. Enter the code that is on its screen now.';
    case 'manager_code':
      return 'That is a code created here in MY FOOD ("Create code"). Type it on the device itself (Pair this device → "I have a code from a manager"), or enter the code the device shows.';
    case 'device_unavailable':
      return 'This device is deactivated or belongs to another restaurant.';
    default:
      return 'That pairing code is not valid. Check the code shown on the device and try again.';
  }
}

/** Step 2 (manager, in Devices): the code shown on the device is approved for one device record. */
export class ApproveDevicePairing {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, deviceId: string, code: string): Promise<{ ok: true }> {
    const identity = required(this.deps.identity, 'identity registry');
    const now = this.deps.clock.now();
    const restaurantId = ctx.principal.restaurantId;
    // 1. The device must be this restaurant's, active, pairable, and the caller allowed to manage it.
    const device = await this.deps.uow.run(restaurantId, async (tx) => {
      const d = await tx.admin.device(deviceId);
      if (!d) throw new DomainError('NOT_FOUND', 'Device not found');
      authorize(ctx.principal, 'device.manage', d.branchId);
      if (!d.isActive) throw new DomainError('VALIDATION_FAILED', 'This device is deactivated');
      if (!PAIRABLE.has(d.kind))
        throw new DomainError('VALIDATION_FAILED', 'Printers are driven by a print agent and are not paired');
      return d;
    });
    // 2. Approve (the database checks the device's restaurant again) or learn why not.
    const normalized = normalizeCode(code);
    const status = await identity.approvePairingRequest(
      this.deps.fingerprint.of({ pairingRequest: normalized }),
      this.deps.fingerprint.of({ pairing: normalized }),
      restaurantId,
      deviceId,
      ctx.principal.staffId,
      now,
    );
    // The same code approved again for the same device (double submit): already done.
    if (status === 'already_approved') return { ok: true };
    if (status !== 'approved')
      throw new DomainError('PAIRING_CODE_INVALID', pairingRefusal(status, device.name), { reason: status });
    // 3. Record it.
    await this.deps.uow.run(restaurantId, (tx) =>
      tx.audit.append({
        branchId: device.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'device.pairing_approved',
        entityType: 'device',
        entityId: deviceId,
        after: { kind: device.kind, name: device.name },
        correlationId: ctx.correlationId,
      }),
    );
    return { ok: true };
  }
}

/** Step 3 (public, on the device): with its secret, the device learns whether it was approved. */
export class CollectDevicePairing {
  constructor(private readonly deps: Dependencies) {}

  async execute(
    secret: string,
    correlationId: string,
  ): Promise<{ status: 'waiting' } | ({ status: 'paired' } & PairDeviceResult)> {
    const identity = required(this.deps.identity, 'identity registry');
    const result = await identity.collectPairingRequest(
      this.deps.fingerprint.of({ pairingSecret: secret }),
      this.deps.clock.now(),
    );
    if (result.status === 'waiting') return { status: 'waiting' };
    if (result.status !== 'approved' || !result.device)
      throw new DomainError(
        'PAIRING_CODE_INVALID',
        'This code has expired. A new one is shown on the screen',
      );
    return { status: 'paired', ...(await completePairing(this.deps, result.device, correlationId)) };
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
      await releaseBranchFromHub(tx, ctx, device.branchId, deviceId, 'The hub was revoked');
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

/**
 * A hub that runs its branch and is revoked or turned off can no longer serve the tills, and while
 * the branch is attached to it the cloud refuses web POS orders: the branch goes back to the web
 * POS in the same transaction (audited), instead of staying blocked (production, 2026-09-30).
 */
async function releaseBranchFromHub(
  tx: Repositories,
  ctx: RequestContext,
  branchId: string,
  deviceId: string,
  reason: string,
): Promise<void> {
  if ((await tx.hub.branchHub(branchId)) !== deviceId) return;
  await tx.hub.setBranchHub(branchId, null);
  await tx.audit.append({
    branchId,
    actorStaffId: ctx.principal.staffId,
    actorDeviceId: ctx.deviceId,
    action: 'branch.hub_detached',
    entityType: 'branch',
    entityId: branchId,
    before: { hubDeviceId: deviceId },
    after: { hubDeviceId: null },
    reason,
    correlationId: ctx.correlationId,
  });
}

function required<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`Application was started without a ${name}`);
  return value;
}

/**
 * Registers the calling person's own phone/laptop as a personal device for PIN sign-in (after they
 * proved their email). Returns the device login, exactly like pairing. On this device their PIN
 * carries their full role; on shared tills management stays restricted.
 */
export async function registerPersonalDevice(
  deps: Dependencies,
  input: { restaurantId: string; staffId: string; displayName: string; correlationId: string },
): Promise<PairDeviceResult> {
  const id = deps.ids.uuid();
  const device = await deps.uow.run(input.restaurantId, async (tx) => {
    const branchId = await tx.admin.firstBranchId();
    if (!branchId) throw new DomainError('UNAVAILABLE', 'This restaurant has no branch yet');
    const name = await tx.admin.createPersonalDevice({
      id,
      branchId,
      staffId: input.staffId,
      displayName: input.displayName,
    });
    await tx.audit.append({
      branchId,
      actorStaffId: input.staffId,
      actorDeviceId: null,
      action: 'device.personal_registered',
      entityType: 'device',
      entityId: id,
      after: { name },
      correlationId: input.correlationId,
    });
    return { branchId, name };
  });
  return completePairing(
    deps,
    {
      deviceId: id,
      restaurantId: input.restaurantId,
      branchId: device.branchId,
      kind: 'pos',
      name: device.name,
      stationId: null,
      previousAuthUserId: null,
    },
    input.correlationId,
  );
}

/**
 * "Use this device with my PIN": an owner or manager, signed in through an email link, registers
 * the browser they are on. Staff without device management use the restaurant's paired tills.
 */
export class RegisterPersonalDevice {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext): Promise<PairDeviceResult> {
    const p = ctx.principal;
    if (p.kind !== 'staff' || !p.staffId) throw new DomainError('FORBIDDEN', 'Sign in as a staff member');
    if (ctx.authMethod !== 'email_link')
      throw new DomainError('FORBIDDEN', 'Open the sign-in link from your email on this device first');
    if (!p.grants.some((g) => g.permissions.has('device.manage')))
      throw new DomainError(
        'FORBIDDEN',
        'Only owners and managers can register their own device. Use a restaurant till.',
      );
    const displayName = await this.deps.uow.run(p.restaurantId, async (tx) => {
      const me = await tx.pins.staffById(p.staffId!);
      if (!me?.isActive) throw new DomainError('FORBIDDEN', 'This staff member is not active');
      return me.displayName;
    });
    return registerPersonalDevice(this.deps, {
      restaurantId: p.restaurantId,
      staffId: p.staffId,
      displayName,
      correlationId: ctx.correlationId,
    });
  }
}
