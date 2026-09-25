import type { DashboardView, ExpoView, SalesReportView } from '@rp/contracts';
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

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Sales for a range of business days (max 92 days). Real payments and items only. */
export class GetSalesReport {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, branchId: string, from: string, to: string): Promise<SalesReportView> {
    authorize(ctx.principal, 'reports.view', branchId);
    if (!DAY.test(from) || !DAY.test(to) || from > to)
      throw new DomainError('VALIDATION_FAILED', 'Choose a valid date range');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 92)
      throw new DomainError('VALIDATION_FAILED', 'Choose at most three months');
    return this.deps.uow.run(ctx.principal.restaurantId, (tx) => tx.read.salesReport(branchId, from, to));
  }
}
