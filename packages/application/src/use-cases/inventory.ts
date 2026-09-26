import type {
  InventoryView,
  RecordCountLineCommand,
  RecordStockMovementCommand,
  SaveInventoryItemCommand,
  SaveRecipeCommand,
  StartStockCountCommand,
  StockCountDecisionCommand,
  StockCountSummaryView,
  StockCountView,
  StockMovementView,
} from '@rp/contracts';
import { DomainError, planCountApproval, planManualMovement, planSaleConsumption, toMilli } from '@rp/domain';
import type { Repositories, StockMovementRecord } from '../ports';
import { authorize, can, type Principal, type RequestContext } from '../principal';
import type { Dependencies } from './shared';

/** Menu (recipes) is restaurant-wide: needs menu.manage for every branch. */
function authorizeMenuWide(p: Principal): void {
  if (!p.grants.some((g) => g.branchId === null && g.permissions.has('menu.manage')))
    throw new DomainError('FORBIDDEN', 'You do not have permission to do this', {
      permission: 'menu.manage',
    });
}

const canSeeStock = (p: Principal, branchId: string) =>
  can(p, 'inventory.manage', branchId) || can(p, 'stock.count', branchId);

function audit(
  tx: Repositories,
  ctx: RequestContext,
  branchId: string,
  action: string,
  entityId: string,
  after: unknown,
  reason?: string | null,
) {
  return tx.audit.append({
    branchId,
    actorStaffId: ctx.principal.staffId,
    actorDeviceId: ctx.deviceId,
    action,
    entityType: action.startsWith('stock_count') ? 'stock_count' : 'inventory_item',
    entityId,
    after,
    reason: reason ?? null,
    correlationId: ctx.correlationId,
  });
}

export class ListInventory {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext, branchId: string): Promise<InventoryView> {
    if (!canSeeStock(ctx.principal, branchId)) authorize(ctx.principal, 'inventory.manage', branchId);
    return this.deps.uow.run(ctx.principal.restaurantId, (tx) => tx.read.inventory(branchId));
  }
}

export class ListStockMovements {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext, branchId: string, itemId: string | null): Promise<StockMovementView[]> {
    if (!canSeeStock(ctx.principal, branchId)) authorize(ctx.principal, 'inventory.manage', branchId);
    return this.deps.uow.run(ctx.principal.restaurantId, (tx) =>
      tx.read.stockMovements(branchId, itemId, itemId ? 200 : 100),
    );
  }
}

/** Item details only. Stock quantity is never edited here: it changes through movements. */
export class SaveInventoryItem {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext, cmd: SaveInventoryItemCommand): Promise<{ id: string }> {
    authorize(ctx.principal, 'inventory.manage', cmd.branchId);
    const id = cmd.id ?? this.deps.ids.uuid();
    await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      if (cmd.id) {
        const existing = await tx.inventory.lockItem(cmd.id);
        if (!existing) throw new DomainError('NOT_FOUND', 'Stock item not found');
        if (existing.branchId !== cmd.branchId)
          throw new DomainError('VALIDATION_FAILED', 'A stock item cannot move to another branch');
      }
      const result = await tx.inventory.saveItem({
        id,
        branchId: cmd.branchId,
        name: cmd.name,
        sku: cmd.sku?.trim() || null,
        category: cmd.category?.trim() || null,
        unit: cmd.unit,
        minQuantity: toMilli(cmd.minQuantity),
        unitCost: cmd.unitCost,
        isActive: cmd.isActive,
      });
      await audit(
        tx,
        ctx,
        cmd.branchId,
        `inventory.item_${result === 'created' ? 'create' : 'update'}`,
        id,
        cmd,
      );
    });
    return { id };
  }
}

/** Delivery, wastage or adjustment. Idempotent by movementId; the item row is locked. */
export class RecordStockMovement {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext, cmd: RecordStockMovementCommand): Promise<{ quantity: number }> {
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const item = await tx.inventory.lockItem(cmd.itemId);
      if (!item) throw new DomainError('NOT_FOUND', 'Stock item not found');
      authorize(ctx.principal, 'inventory.manage', item.branchId);
      const replay = await tx.inventory.movementExists(cmd.movementId);
      if (replay) {
        if (replay.itemId !== cmd.itemId)
          throw new DomainError('IDEMPOTENCY_MISMATCH', 'This movement id was already used for another item');
        return { quantity: item.quantity / 1000 };
      }
      if (!item.isActive) throw new DomainError('VALIDATION_FAILED', `${item.name} is inactive`);
      const { delta, after } = planManualMovement(cmd.kind, item.quantity, toMilli(cmd.quantity), cmd.reason);
      await tx.inventory.insertMovements([
        {
          id: cmd.movementId,
          branchId: item.branchId,
          itemId: item.id,
          kind: cmd.kind,
          delta,
          after,
          unitCost: cmd.unitCost ?? null,
          reason: cmd.reason?.trim() || null,
          reference: cmd.reference?.trim() || null,
          stockCountId: null,
          orderId: null,
          staffId: ctx.principal.staffId,
        },
      ]);
      await tx.inventory.setQuantity(item.id, after);
      await audit(
        tx,
        ctx,
        item.branchId,
        `inventory.${cmd.kind}`,
        item.id,
        { quantity: delta / 1000, after: after / 1000, reference: cmd.reference ?? null },
        cmd.reason,
      );
      return { quantity: after / 1000 };
    });
  }
}

export class ListStockCounts {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext, branchId: string): Promise<StockCountSummaryView[]> {
    if (!canSeeStock(ctx.principal, branchId)) authorize(ctx.principal, 'stock.count', branchId);
    return this.deps.uow.run(ctx.principal.restaurantId, (tx) => tx.read.stockCounts(branchId));
  }
}

export class GetStockCount {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext, countId: string): Promise<StockCountView> {
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const count = await tx.read.stockCount(countId);
      const head = count ? await tx.inventory.lockCount(countId) : null;
      if (!count || !head) throw new DomainError('NOT_FOUND', 'Stock count not found');
      if (!canSeeStock(ctx.principal, head.branchId)) authorize(ctx.principal, 'stock.count', head.branchId);
      return count;
    });
  }
}

/** Starts a count: snapshots the system quantity of the chosen (default: all active) items. */
export class StartStockCount {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext, cmd: StartStockCountCommand): Promise<{ countId: string }> {
    authorize(ctx.principal, 'stock.count', cmd.branchId);
    await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const existing = await tx.inventory.lockCount(cmd.countId);
      if (existing) return; // retry of the same start
      const lines = await tx.inventory.insertCount({
        id: cmd.countId,
        branchId: cmd.branchId,
        note: cmd.note?.trim() || null,
        staffId: ctx.principal.staffId,
        itemIds: cmd.itemIds ?? null,
      });
      if (lines === 0) throw new DomainError('VALIDATION_FAILED', 'There are no active stock items to count');
      await audit(tx, ctx, cmd.branchId, 'stock_count.start', cmd.countId, { lines, note: cmd.note ?? null });
    });
    return { countId: cmd.countId };
  }
}

export class RecordCountLine {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext, countId: string, cmd: RecordCountLineCommand): Promise<{ ok: true }> {
    await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const count = await tx.inventory.lockCount(countId);
      if (!count) throw new DomainError('NOT_FOUND', 'Stock count not found');
      authorize(ctx.principal, 'stock.count', count.branchId);
      if (count.status !== 'open')
        throw new DomainError(
          'VALIDATION_FAILED',
          'This count has been submitted; it can no longer be changed',
        );
      const saved = await tx.inventory.saveCountLine(
        countId,
        cmd.itemId,
        cmd.countedQuantity === null ? null : toMilli(cmd.countedQuantity),
        cmd.reason?.trim() || null,
        ctx.principal.staffId,
      );
      if (!saved) throw new DomainError('NOT_FOUND', 'That item is not part of this count');
    });
    return { ok: true };
  }
}

/** The counter hands the count over for approval. Stock is not changed yet. */
export class SubmitStockCount {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext, countId: string, cmd: StockCountDecisionCommand): Promise<{ ok: true }> {
    await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const count = await tx.inventory.lockCount(countId);
      if (!count) throw new DomainError('NOT_FOUND', 'Stock count not found');
      authorize(ctx.principal, 'stock.count', count.branchId);
      if (count.status !== 'open') throw new DomainError('VALIDATION_FAILED', 'This count is not open');
      if (!count.lines.some((l) => l.countedQuantity !== null))
        throw new DomainError('VALIDATION_FAILED', 'Nothing has been counted yet');
      if (
        !(await tx.inventory.setCountStatus(countId, 'submitted', ctx.principal.staffId, cmd.expectedVersion))
      )
        throw new DomainError('VERSION_CONFLICT', 'Someone else changed this count. Reload and try again.');
      await audit(tx, ctx, count.branchId, 'stock_count.submit', countId, {
        counted: count.lines.filter((l) => l.countedQuantity !== null).length,
      });
    });
    return { ok: true };
  }
}

/**
 * A manager approves a submitted count: variances against the CURRENT stock become 'count'
 * movements (with the counter's reasons), and stock is set to the counted quantities.
 */
export class ApproveStockCount {
  constructor(private readonly deps: Dependencies) {}
  async execute(
    ctx: RequestContext,
    countId: string,
    cmd: StockCountDecisionCommand,
  ): Promise<{ adjusted: number }> {
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const count = await tx.inventory.lockCount(countId);
      if (!count) throw new DomainError('NOT_FOUND', 'Stock count not found');
      authorize(ctx.principal, 'inventory.manage', count.branchId);
      if (count.status !== 'submitted')
        throw new DomainError('VALIDATION_FAILED', 'Only a submitted count can be approved');
      const items = await tx.inventory.lockItems(count.lines.map((l) => l.itemId));
      const current = new Map(items.map((i) => [i.id, i.quantity]));
      const plan = planCountApproval(count.lines, (id) => current.get(id) ?? 0);
      const movements: StockMovementRecord[] = plan.map((p) => ({
        id: this.deps.ids.uuid(),
        branchId: count.branchId,
        itemId: p.itemId,
        kind: 'count',
        delta: p.delta,
        after: p.after,
        unitCost: null,
        reason: p.reason,
        reference: null,
        stockCountId: countId,
        orderId: null,
        staffId: ctx.principal.staffId,
      }));
      await tx.inventory.insertMovements(movements);
      for (const p of plan) await tx.inventory.setQuantity(p.itemId, p.after);
      await tx.inventory.setCountSystemQuantities(countId, current);
      if (
        !(await tx.inventory.setCountStatus(countId, 'approved', ctx.principal.staffId, cmd.expectedVersion))
      )
        throw new DomainError('VERSION_CONFLICT', 'Someone else changed this count. Reload and try again.');
      await audit(tx, ctx, count.branchId, 'stock_count.approve', countId, {
        adjustments: plan.map((p) => ({ itemId: p.itemId, variance: p.delta / 1000, reason: p.reason })),
      });
      return { adjusted: plan.length };
    });
  }
}

export class CancelStockCount {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext, countId: string, cmd: StockCountDecisionCommand): Promise<{ ok: true }> {
    await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const count = await tx.inventory.lockCount(countId);
      if (!count) throw new DomainError('NOT_FOUND', 'Stock count not found');
      authorize(ctx.principal, 'inventory.manage', count.branchId);
      if (count.status === 'approved' || count.status === 'cancelled')
        throw new DomainError('VALIDATION_FAILED', 'This count is already closed');
      if (
        !(await tx.inventory.setCountStatus(countId, 'cancelled', ctx.principal.staffId, cmd.expectedVersion))
      )
        throw new DomainError('VERSION_CONFLICT', 'Someone else changed this count. Reload and try again.');
      await audit(tx, ctx, count.branchId, 'stock_count.cancel', countId, {});
    });
    return { ok: true };
  }
}

export class GetRecipe {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext, productId: string) {
    authorizeMenuWide(ctx.principal);
    return this.deps.uow.run(ctx.principal.restaurantId, (tx) => tx.read.recipe(productId));
  }
}

/** What one unit of a product consumes. Only products with a recipe deduct stock when sold. */
export class SaveRecipe {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext, productId: string, cmd: SaveRecipeCommand): Promise<{ ok: true }> {
    authorizeMenuWide(ctx.principal);
    await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const ids = [...new Set(cmd.components.map((c) => c.itemId))];
      if (ids.length !== cmd.components.length)
        throw new DomainError('VALIDATION_FAILED', 'Each stock item can appear only once in a recipe');
      const items = await tx.inventory.lockItems(ids);
      if (items.length !== ids.length) throw new DomainError('NOT_FOUND', 'Stock item not found');
      await tx.inventory.setRecipe(
        productId,
        cmd.components.map((c) => ({ itemId: c.itemId, quantity: toMilli(c.quantity) })),
      );
      await tx.audit.append({
        branchId: null,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'menu.recipe_update',
        entityType: 'product',
        entityId: productId,
        after: cmd.components,
        correlationId: ctx.correlationId,
      });
    });
    return { ok: true };
  }
}

/**
 * Called inside the cancellation transaction: returns to stock exactly what the ledger shows the
 * sales of this order (and of orders merged into it) took. Compensating 'sale_reversal' movements;
 * the original sales stay in the ledger. The database refuses a second reversal per order and item,
 * so a repeated cancellation can never return stock twice.
 */
export async function reverseStockForOrder(
  tx: Repositories,
  deps: Pick<Dependencies, 'ids'>,
  input: {
    orderId: string;
    relatedOrderIds: string[];
    orderNumber: number;
    staffId: string | null;
    reason: string;
  },
): Promise<string[]> {
  const taken = await tx.inventory.saleTotals([input.orderId, ...input.relatedOrderIds]);
  const itemIds = [...taken.entries()].filter(([, q]) => q < 0).map(([id]) => id);
  if (itemIds.length === 0) return [];
  const items = await tx.inventory.lockItems(itemIds);
  const movements: StockMovementRecord[] = items.map((item) => {
    const back = -(taken.get(item.id) ?? 0);
    return {
      id: deps.ids.uuid(),
      branchId: item.branchId,
      itemId: item.id,
      kind: 'sale_reversal',
      delta: back,
      after: item.quantity + back,
      unitCost: item.unitCost,
      reason: `Order cancelled: ${input.reason}`,
      reference: `Order #${input.orderNumber}`,
      stockCountId: null,
      orderId: input.orderId,
      staffId: input.staffId,
    };
  });
  const reversed = new Set(await tx.inventory.insertReversals(movements));
  for (const m of movements) if (reversed.has(m.itemId)) await tx.inventory.setQuantity(m.itemId, m.after);
  return [...reversed];
}

/**
 * Called inside the order-submission transaction: deducts stock for the lines just sent, for
 * products that have a recipe. Never blocks a sale (stock may go negative: the count corrects it).
 */
export async function deductStockForSale(
  tx: Repositories,
  deps: Pick<Dependencies, 'ids'>,
  input: {
    branchId: string;
    orderId: string;
    orderNumber: number;
    staffId: string | null;
    lines: { productId: string; quantity: number }[];
  },
): Promise<void> {
  const recipes = await tx.inventory.recipes([...new Set(input.lines.map((l) => l.productId))]);
  if (recipes.size === 0) return;
  const use = planSaleConsumption(input.lines, recipes);
  const items = await tx.inventory.lockItems([...use.keys()]);
  const movements: StockMovementRecord[] = [];
  for (const item of items) {
    if (item.branchId !== input.branchId || !item.isActive) continue;
    const delta = -(use.get(item.id) ?? 0);
    if (delta === 0) continue;
    movements.push({
      id: deps.ids.uuid(),
      branchId: item.branchId,
      itemId: item.id,
      kind: 'sale',
      delta,
      after: item.quantity + delta,
      // Cost snapshot: what this ingredient cost when it was used (reports total it as cost of goods).
      unitCost: item.unitCost,
      reason: null,
      reference: `Order #${input.orderNumber}`,
      stockCountId: null,
      orderId: input.orderId,
      staffId: input.staffId,
    });
  }
  await tx.inventory.insertMovements(movements);
  for (const m of movements) await tx.inventory.setQuantity(m.itemId, m.after);
}
