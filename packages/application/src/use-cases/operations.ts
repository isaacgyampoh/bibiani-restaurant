import type { DashboardView, ExpoView } from '@rp/contracts';
import { businessDay, DomainError } from '@rp/domain';
import { authorize, can, type RequestContext } from '../principal';
import type { Dependencies } from './shared';

/** Today's business of one branch: sales, orders, tables, kitchen load, stock alerts. */
export class GetDashboard {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, branchId: string): Promise<DashboardView> {
    authorize(ctx.principal, 'reports.view', branchId);
    const now = this.deps.clock.now();
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const branch = await tx.config.branch(branchId);
      if (!branch) throw new DomainError('NOT_FOUND', 'Branch not found', { branchId });
      return tx.read.dashboard(branchId, businessDay(now, branch.timezone, branch.businessDayCutoff), now);
    });
  }
}

/** Expediter / supervisor board: which stations of each active order are ready, and what is late. */
export class GetExpoBoard {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, branchId: string): Promise<ExpoView> {
    if (!can(ctx.principal, 'kitchen.operate', branchId)) authorize(ctx.principal, 'order.view', branchId);
    const now = this.deps.clock.now();
    return this.deps.uow.run(ctx.principal.restaurantId, (tx) => tx.read.expo(branchId, now));
  }
}
