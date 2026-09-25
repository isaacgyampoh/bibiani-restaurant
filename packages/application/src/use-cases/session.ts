import type { FloorView, MenuView, MeView, OperationsView, SetTableStatusCommand } from '@rp/contracts';
import { DomainError } from '@rp/domain';
import { authorize, can, type RequestContext } from '../principal';
import type { Dependencies } from './shared';

/** Who am I and what may I do. The UI uses this only to hide actions; the server still authorizes each call. */
export class GetMe {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, displayName: string): Promise<MeView> {
    const info = await this.deps.uow.run(ctx.principal.restaurantId, (tx) =>
      tx.read.me({ staffId: ctx.principal.staffId, deviceId: ctx.deviceId }),
    );
    const permissions: Record<string, string[]> = {};
    for (const g of ctx.principal.grants) permissions[g.branchId ?? '*'] = [...g.permissions].sort();
    return { kind: ctx.principal.kind, displayName, permissions, ...info };
  }
}

export class GetMenu {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, branchId: string): Promise<MenuView> {
    if (!can(ctx.principal, 'order.create', branchId)) authorize(ctx.principal, 'menu.manage', branchId);
    return this.deps.uow.run(ctx.principal.restaurantId, (tx) => tx.read.menu(branchId));
  }
}

export class GetFloor {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, branchId: string): Promise<FloorView> {
    authorize(ctx.principal, 'order.view', branchId);
    const now = this.deps.clock.now();
    return this.deps.uow.run(ctx.principal.restaurantId, (tx) => tx.read.floor(branchId, now));
  }
}

/** Table housekeeping: cleaning -> available, reserve, out of service. Occupied state comes from orders, never set by hand. */
export class SetTableStatus {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, tableId: string, cmd: SetTableStatusCommand): Promise<{ ok: true }> {
    await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const table = await tx.config.table(tableId);
      if (!table) throw new DomainError('NOT_FOUND', 'Table not found', { tableId });
      authorize(ctx.principal, 'order.fulfil', table.branchId);
      if (await tx.orders.activeOrderIdForTable(tableId)) {
        throw new DomainError('TABLE_UNAVAILABLE', `Table ${table.label} has an open order`);
      }
      await tx.admin.setTableStatus(tableId, cmd.status);
    });
    return { ok: true };
  }
}

/** Device and printer liveness from real heartbeats and print outcomes (not browser connectivity). */
export class GetOperationsStatus {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, branchId: string): Promise<OperationsView> {
    if (!can(ctx.principal, 'device.manage', branchId)) authorize(ctx.principal, 'print.manage', branchId);
    const now = this.deps.clock.now();
    return this.deps.uow.run(ctx.principal.restaurantId, (tx) => tx.read.operations(branchId, now));
  }
}
