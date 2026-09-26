import type {
  HubBatchCommand,
  HubBatchResultView,
  HubSnapshotView,
  SetBranchHubCommand,
} from '@rp/contracts';
import { DomainError } from '@rp/domain';
import type { HubIngestOutcome } from '../ports';
import { authorize, type Principal, type RequestContext } from '../principal';
import { CommitLog, type Dependencies } from './shared';

/** The calling in-store hub, or FORBIDDEN. A hub only ever works in its own branch. */
function hubOf(principal: Principal): { deviceId: string; branchId: string } {
  const branchId = principal.grants[0]?.branchId;
  if (principal.kind !== 'device' || principal.deviceKind !== 'hub' || !principal.deviceId || !branchId) {
    throw new DomainError('FORBIDDEN', 'Only a paired MY FOOD hub can do this');
  }
  authorize(principal, 'hub.sync', branchId);
  return { deviceId: principal.deviceId, branchId };
}

/** Cloud -> hub: the branch configuration and recent stock movements. Read-only. */
export class GetHubSnapshot {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, since: string | null): Promise<HubSnapshotView> {
    const hub = hubOf(ctx.principal);
    const now = this.deps.clock.now();
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => ({
      generatedAt: now.toISOString(),
      restaurantId: ctx.principal.restaurantId,
      branchId: hub.branchId,
      hubDeviceId: hub.deviceId,
      attached: (await tx.hub.branchHub(hub.branchId)) === hub.deviceId,
      tables: await tx.hub.snapshot(hub.branchId),
      movements: await tx.hub.movementsSince(hub.branchId, since),
      orderCounters: await tx.hub.orderCounters(hub.branchId),
    }));
  }
}

/**
 * Hub -> cloud: floor records made in the restaurant (online or offline). Applied in one transaction;
 * a record that cannot be applied is reported back as a conflict instead of failing the batch.
 * The same batch id applied again returns the first result and changes nothing.
 */
export class IngestHubBatch {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, cmd: HubBatchCommand): Promise<HubBatchResultView> {
    const hub = hubOf(ctx.principal);
    const log = new CommitLog(ctx);
    const result = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const replay = await tx.hub.findBatch(cmd.batchId);
      if (replay) return replay;
      if ((await tx.hub.branchHub(hub.branchId)) !== hub.deviceId) {
        throw new DomainError(
          'FORBIDDEN',
          'This hub does not operate the branch. Attach it in Devices before it can upload.',
          { reason: 'hub_not_attached' },
        );
      }
      const outcome: HubIngestOutcome = {
        batchId: cmd.batchId,
        records: cmd.records.length,
        applied: 0,
        conflicts: [],
      };
      for (const [index, { table, row, deleted }] of cmd.records.entries()) {
        try {
          if (
            await tx.hub.applyUpload(
              hub.branchId,
              ctx.principal.restaurantId,
              table,
              row,
              deleted,
              hub.deviceId,
            )
          )
            outcome.applied++;
        } catch (error) {
          const reason =
            (error as { name?: string; reason?: string }).name === 'HubRecordError'
              ? (error as { reason: string }).reason
              : 'unexpected';
          if (reason === 'unexpected') throw error;
          outcome.conflicts.push({ index, table, key: recordKey(row), reason });
        }
      }
      await tx.hub.saveBatch({ ...outcome, branchId: hub.branchId, hubDeviceId: hub.deviceId });
      if (outcome.conflicts.length > 0) {
        await tx.audit.append({
          branchId: hub.branchId,
          actorStaffId: null,
          actorDeviceId: hub.deviceId,
          action: 'hub.sync_conflicts',
          entityType: 'device',
          entityId: hub.deviceId,
          after: { batchId: cmd.batchId, conflicts: outcome.conflicts.slice(0, 50) },
          correlationId: ctx.correlationId,
        });
      }
      return outcome;
    });
    log.add('hub.batch_ingested', {
      hubDeviceId: hub.deviceId,
      batchId: result.batchId,
      records: result.records,
      applied: result.applied,
      conflicts: result.conflicts.length,
    });
    log.flush(this.deps.logger);
    return result;
  }
}

function recordKey(row: Record<string, unknown>): string {
  const key =
    row.id ?? row.origin_id ?? [row.order_item_id, row.ticket_id, row.tax_rate_id].filter(Boolean).join(':');
  return typeof key === 'string' ? key.slice(0, 80) : String(key ?? '').slice(0, 80);
}

/**
 * A manager attaches a paired hub to its branch (the hub becomes authoritative for the branch's
 * floor records) or detaches it (the web POS takes over again). Audited.
 */
export class SetBranchHub {
  constructor(private readonly deps: Dependencies) {}

  async execute(
    ctx: RequestContext,
    branchId: string,
    cmd: SetBranchHubCommand,
  ): Promise<{ hubDeviceId: string | null }> {
    authorize(ctx.principal, 'device.manage', branchId);
    const log = new CommitLog(ctx);
    await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const before = await tx.hub.branchHub(branchId);
      if (cmd.hubDeviceId) {
        const device = await tx.admin.get('device', cmd.hubDeviceId);
        if (!device || device.kind !== 'hub' || device.branch_id !== branchId || !device.is_active) {
          throw new DomainError('VALIDATION_FAILED', 'Choose an active MY FOOD hub of this branch');
        }
        if (!device.auth_user_id)
          throw new DomainError('VALIDATION_FAILED', 'Pair the hub before attaching it');
        // Orders opened on the web POS (not by this hub) would be invisible to the hub: finish them first.
        const open = before === cmd.hubDeviceId ? 0 : await tx.hub.openOrders(branchId, cmd.hubDeviceId);
        if (open > 0)
          throw new DomainError(
            'VALIDATION_FAILED',
            `Finish or cancel the ${open} open order${open === 1 ? '' : 's'} of this branch before the hub takes over`,
          );
      }
      await tx.hub.setBranchHub(branchId, cmd.hubDeviceId);
      await tx.audit.append({
        branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: cmd.hubDeviceId ? 'branch.hub_attached' : 'branch.hub_detached',
        entityType: 'branch',
        entityId: branchId,
        before: { hubDeviceId: before },
        after: { hubDeviceId: cmd.hubDeviceId },
        correlationId: ctx.correlationId,
      });
      log.add(cmd.hubDeviceId ? 'branch.hub_attached' : 'branch.hub_detached', {
        branchId,
        hubDeviceId: cmd.hubDeviceId,
      });
    });
    log.flush(this.deps.logger);
    return { hubDeviceId: cmd.hubDeviceId };
  }
}
