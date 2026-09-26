import type {
  ManualDiscountCommand,
  PromotionPreviewView,
  PromotionView,
  SavePromotionCommand,
} from '@rp/contracts';
import {
  ACTIVE_ITEM,
  allocateDiscount,
  applyManualDiscount,
  assertOrderOpen,
  assertValidPromotion,
  computeTotals,
  DomainError,
  formatMinor,
  localMoment,
  type Promotion,
  promotionCovers,
  promotionDiscount,
  promotionPhase,
  promotionsConflict,
} from '@rp/domain';
import type { PromotionRecord, Repositories } from '../ports';
import { authorize, type RequestContext } from '../principal';
import { authorizeRestaurantWide } from './administration';
import { CommitLog, type Dependencies, settleOrderState } from './shared';

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Plain-language summary of what a promotion does and when. */
export function describePromotion(p: Omit<Promotion, 'id' | 'createdAt'>, currency: string): string {
  const money = (m: number) => formatMinor(m, currency);
  const what =
    p.kind === 'percent_off'
      ? `${(p.percentBp ?? 0) / 100}% off`
      : p.kind === 'amount_off'
        ? `${money(p.amount ?? 0)} off each`
        : p.kind === 'fixed_price'
          ? `${money(p.amount ?? 0)} each`
          : `${p.bundleQuantity} for ${money(p.amount ?? 0)}`;
  const days =
    !p.daysOfWeek || p.daysOfWeek.length === 7
      ? 'every day'
      : [...p.daysOfWeek]
          .sort()
          .map((d) => DAY[d])
          .join(', ');
  const time = p.startTime && p.endTime ? `, ${p.startTime}–${p.endTime}` : '';
  const dates = p.startsOn || p.endsOn ? ` · ${p.startsOn ?? 'now'} to ${p.endsOn ?? 'no end date'}` : '';
  return `${what} · ${days}${time}${dates}`;
}

function toView(p: PromotionRecord, now: Date, timeZone: string, currency: string): PromotionView {
  return {
    ...p,
    daysOfWeek: p.daysOfWeek ? [...p.daysOfWeek] : null,
    productIds: [...p.productIds],
    categoryIds: [...p.categoryIds],
    phase: promotionPhase(p, now, timeZone),
    summary: describePromotion(p, currency),
  };
}

function draftFrom(cmd: SavePromotionCommand, id: string): Omit<Promotion, 'createdAt'> {
  return {
    id,
    name: cmd.name,
    kind: cmd.kind,
    percentBp: cmd.kind === 'percent_off' ? (cmd.percentBp ?? null) : null,
    amount: cmd.kind === 'percent_off' ? null : (cmd.amount ?? null),
    bundleQuantity: cmd.kind === 'bundle_price' ? (cmd.bundleQuantity ?? null) : null,
    appliesToAll: cmd.appliesToAll,
    productIds: cmd.productIds,
    categoryIds: cmd.categoryIds,
    branchId: cmd.branchId ?? null,
    startsOn: cmd.startsOn ?? null,
    endsOn: cmd.endsOn ?? null,
    daysOfWeek: cmd.daysOfWeek && cmd.daysOfWeek.length < 7 ? [...new Set(cmd.daysOfWeek)].sort() : null,
    startTime: cmd.startTime ?? null,
    endTime: cmd.endTime ?? null,
    priority: cmd.priority,
    status: cmd.status,
  };
}

async function conflictsOf(tx: Repositories, draft: Omit<Promotion, 'createdAt'>): Promise<string[]> {
  const [all, paths] = await Promise.all([tx.promotions.list(), tx.promotions.productCategoryPaths()]);
  const me = { ...draft, createdAt: '' };
  return all.filter((o) => promotionsConflict(me, o, paths)).map((o) => o.name);
}

export class ListPromotions {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext): Promise<PromotionView[]> {
    const p = ctx.principal;
    if (!p.grants.some((g) => g.permissions.has('promotions.manage') || g.permissions.has('reports.view')))
      throw new DomainError('FORBIDDEN', 'You do not have permission to do this');
    const now = this.deps.clock.now();
    return this.deps.uow.run(p.restaurantId, async (tx) => {
      const { timeZone, currency } = await tx.promotions.context();
      return (await tx.promotions.list()).map((x) => toView(x, now, timeZone, currency));
    });
  }
}

/** Exactly what a promotion would do, before it is saved: prices per product, schedule, conflicts. */
export class PreviewPromotion {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext, cmd: SavePromotionCommand): Promise<PromotionPreviewView> {
    authorizeRestaurantWide(ctx, 'promotions.manage');
    const now = this.deps.clock.now();
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const draft = draftFrom(cmd, cmd.id ?? '00000000-0000-0000-0000-000000000000');
      let error: string | null = null;
      try {
        assertValidPromotion(draft);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const { branchId, timeZone, currency } = await tx.promotions.context();
      const paths = await tx.promotions.productCategoryPaths();
      const covered = [...paths.entries()]
        .filter(([id, path]) => promotionCovers(draft, id, path))
        .map(([id]) => id);
      const products = branchId ? await tx.catalog.productsForSale(branchId, covered) : new Map();
      const promo = { ...draft, createdAt: '' };
      const qty = draft.kind === 'bundle_price' ? (draft.bundleQuantity ?? 1) : 1;
      const lines = [...products.values()]
        .map((pr) => {
          const discount = error ? 0 : promotionDiscount(promo, pr.price, qty);
          return {
            productId: pr.id,
            name: pr.name,
            quantity: qty,
            normalPrice: pr.price * qty,
            promoPrice: pr.price * qty - discount,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        valid: error === null,
        error,
        summary: describePromotion(draft, currency),
        phase: promotionPhase(promo, now, timeZone),
        lines,
        conflicts: error ? [] : await conflictsOf(tx, draft),
        restaurantDate: localMoment(now, timeZone).date,
      };
    });
  }
}

export class SavePromotion {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext, cmd: SavePromotionCommand): Promise<{ id: string }> {
    authorizeRestaurantWide(ctx, 'promotions.manage');
    const id = cmd.id ?? this.deps.ids.uuid();
    const draft = draftFrom(cmd, id);
    assertValidPromotion(draft);
    await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const before = cmd.id ? await tx.promotions.get(cmd.id) : null;
      if (cmd.id && !before) throw new DomainError('NOT_FOUND', 'Promotion not found');
      const conflicts = await conflictsOf(tx, draft);
      if (conflicts.length)
        throw new DomainError(
          'VALIDATION_FAILED',
          `This overlaps “${conflicts[0]}” (same items, same time, same priority). Give one of them a higher priority so it is clear which price applies.`,
          { field: 'priority' },
        );
      const result = await tx.promotions.save(
        draft,
        ctx.principal.staffId,
        before ? (cmd.expectedVersion ?? before.version) : null,
      );
      await tx.audit.append({
        branchId: draft.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: `promotion.${result === 'created' ? 'create' : 'update'}`,
        entityType: 'promotion',
        entityId: id,
        before,
        after: draft,
        correlationId: ctx.correlationId,
      });
    });
    return { id };
  }
}

export class SetPromotionStatus {
  constructor(private readonly deps: Dependencies) {}
  async execute(
    ctx: RequestContext,
    id: string,
    action: 'activate' | 'pause' | 'end',
    expectedVersion: number,
  ): Promise<{ ok: true }> {
    authorizeRestaurantWide(ctx, 'promotions.manage');
    const now = this.deps.clock.now();
    await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const p = await tx.promotions.get(id);
      if (!p) throw new DomainError('NOT_FOUND', 'Promotion not found');
      const { timeZone } = await tx.promotions.context();
      let endsOn: string | undefined;
      if (action === 'end') {
        // Ends immediately: its last day was yesterday (restaurant time).
        const yesterday = new Date(now.getTime() - 86_400_000);
        endsOn = localMoment(yesterday, timeZone).date;
      }
      if (action === 'activate') {
        const conflicts = await conflictsOf(tx, { ...p, status: 'active' });
        if (conflicts.length)
          throw new DomainError(
            'VALIDATION_FAILED',
            `It would overlap “${conflicts[0]}” with the same priority. Change one of the priorities first.`,
          );
      }
      const status = action === 'activate' ? 'active' : 'paused';
      if (!(await tx.promotions.setStatus(id, status, endsOn, ctx.principal.staffId, expectedVersion)))
        throw new DomainError(
          'VERSION_CONFLICT',
          'Someone else changed this promotion. Reload and try again.',
        );
      await tx.audit.append({
        branchId: p.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: `promotion.${action}`,
        entityType: 'promotion',
        entityId: id,
        before: { status: p.status, endsOn: p.endsOn },
        after: { status, endsOn: endsOn ?? p.endsOn },
        correlationId: ctx.correlationId,
      });
    });
    return { ok: true };
  }
}

/**
 * Manager discount on an order, kept separate from automatic promotions. Spread over the order's
 * active lines (so taxes stay correct per line), never more than what is still unpaid, one active
 * discount per order (applying again replaces it), and every change is audited with who, why,
 * the original and the final total. Retries with the same discount id change nothing.
 */
export class ApplyManualDiscount {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext, orderId: string, cmd: ManualDiscountCommand) {
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const view = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const agg = await tx.orders.findForUpdate(orderId);
      if (!agg) throw new DomainError('NOT_FOUND', 'Order not found');
      authorize(ctx.principal, 'discount.apply', agg.header.branchId);
      if (await tx.discounts.find(cmd.discountId)) return (await tx.read.order(orderId))!; // replay
      assertOrderOpen(agg.header.status);
      const previous = await tx.discounts.active(orderId);
      const active = agg.items.filter(ACTIVE_ITEM);
      // Start from the lines without any manager discount.
      const reset = active.map((i) => applyManualDiscount(i, 0));
      const base = reset.reduce((a, i) => a + i.lineTotal, 0);
      const amount = cmd.kind === 'percent' ? Math.round((base * cmd.value) / 10_000) : cmd.value;
      if (cmd.kind === 'percent' && (cmd.value < 1 || cmd.value > 10_000))
        throw new DomainError('VALIDATION_FAILED', 'A percentage discount is between 0.01% and 100%');
      if (amount <= 0) throw new DomainError('VALIDATION_FAILED', 'The discount must be more than zero');
      if (amount > base) throw new DomainError('VALIDATION_FAILED', 'The discount is larger than the order');
      const shares = allocateDiscount(
        amount,
        reset.map((i) => ({ id: i.id, net: i.lineTotal })),
      );
      const repriced = reset.map((i) => applyManualDiscount(i, shares.get(i.id) ?? 0));
      const originalTotals = computeTotals(agg.items);
      const itemsAfter = agg.items.map((i) => repriced.find((r) => r.id === i.id) ?? i);
      const finalTotals = computeTotals(itemsAfter);
      const netPaid = agg.header.paidTotal - agg.header.refundedTotal;
      if (finalTotals.grandTotal < netPaid)
        throw new DomainError(
          'VALIDATION_FAILED',
          `The discount is more than what is still unpaid (${formatMinor(originalTotals.grandTotal - netPaid, (await tx.promotions.context()).currency)})`,
        );
      await tx.discounts.updateItemPricing(repriced);
      agg.items = itemsAfter;
      if (previous) await tx.discounts.remove(previous.id, ctx.principal.staffId, now);
      await tx.discounts.insert({
        id: cmd.discountId,
        orderId,
        kind: cmd.kind,
        value: cmd.value,
        amount,
        reason: cmd.reason,
        originalTotal: originalTotals.grandTotal,
        finalTotal: finalTotals.grandTotal,
        appliedByStaffId: ctx.principal.staffId,
      });
      await tx.audit.append({
        branchId: agg.header.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'order.discount',
        entityType: 'order',
        entityId: orderId,
        before: { grandTotal: originalTotals.grandTotal, replaced: previous?.id ?? null },
        after: { kind: cmd.kind, value: cmd.value, amount, grandTotal: finalTotals.grandTotal },
        reason: cmd.reason,
        correlationId: ctx.correlationId,
      });
      log.add('order.discounted', { orderId, amount });
      await settleOrderState(tx, agg, ctx, now, log);
      return (await tx.read.order(orderId))!;
    });
    log.flush(this.deps.logger);
    return view;
  }
}

export class RemoveManualDiscount {
  constructor(private readonly deps: Dependencies) {}
  async execute(ctx: RequestContext, orderId: string) {
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const view = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const agg = await tx.orders.findForUpdate(orderId);
      if (!agg) throw new DomainError('NOT_FOUND', 'Order not found');
      authorize(ctx.principal, 'discount.apply', agg.header.branchId);
      const current = await tx.discounts.active(orderId);
      if (!current) return (await tx.read.order(orderId))!;
      assertOrderOpen(agg.header.status);
      const repriced = agg.items.filter((i) => i.manualDiscount > 0).map((i) => applyManualDiscount(i, 0));
      await tx.discounts.updateItemPricing(repriced);
      agg.items = agg.items.map((i) => repriced.find((r) => r.id === i.id) ?? i);
      await tx.discounts.remove(current.id, ctx.principal.staffId, now);
      await tx.audit.append({
        branchId: agg.header.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'order.discount_removed',
        entityType: 'order',
        entityId: orderId,
        before: { amount: current.amount, reason: current.reason },
        after: {},
        correlationId: ctx.correlationId,
      });
      await settleOrderState(tx, agg, ctx, now, log);
      return (await tx.read.order(orderId))!;
    });
    log.flush(this.deps.logger);
    return view;
  }
}
