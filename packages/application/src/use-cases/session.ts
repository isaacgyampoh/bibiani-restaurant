import type { FloorView, MenuView, MeView, OperationsView, SetTableStatusCommand } from '@rp/contracts';
import {
  choosePromotion,
  DomainError,
  formatMinor,
  isPromotionLive,
  type Promotion,
  promotionCovers,
} from '@rp/domain';
import { authorize, can, type RequestContext } from '../principal';
import type { Dependencies } from './shared';

/** Who am I and what may I do. The UI uses this only to hide actions; the server still authorizes each call. */
export class GetMe {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, displayName: string): Promise<MeView> {
    const [info, staff] = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => [
      await tx.read.me({ staffId: ctx.principal.staffId, deviceId: ctx.deviceId }),
      ctx.principal.staffId ? await tx.pins.staffById(ctx.principal.staffId) : null,
    ]);
    const permissions: Record<string, string[]> = {};
    for (const g of ctx.principal.grants) permissions[g.branchId ?? '*'] = [...g.permissions].sort();
    return {
      kind: ctx.principal.kind,
      displayName,
      permissions,
      ...info,
      staffId: ctx.principal.staffId,
      pin: staff ? { hasPin: staff.hasPin, mustChange: staff.mustChange } : null,
      signedInWith: ctx.authMethod ?? 'password',
    };
  }
}

export class GetMenu {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, branchId: string): Promise<MenuView> {
    if (!can(ctx.principal, 'order.create', branchId)) authorize(ctx.principal, 'menu.manage', branchId);
    const now = this.deps.clock.now();
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const [menu, promotions, branch] = await Promise.all([
        tx.read.menu(branchId),
        tx.promotions.list(),
        tx.config.branch(branchId),
      ]);
      const images = this.deps.images;
      const withPhotos: MenuView = {
        ...menu,
        products: menu.products.map(({ imagePath, ...p }) => ({
          ...p,
          imageUrl: imagePath && images ? images.publicUrl(imagePath) : null,
        })),
      };
      return withLivePromotions(withPhotos, promotions, now, branch?.timezone ?? 'UTC', branchId);
    });
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

/**
 * Marks each product with the promotion live right now for one unit (bundles: the bundle price),
 * so the POS can show it. Pricing itself is always decided again on the server when items are added.
 */
export function withLivePromotions(
  menu: MenuView,
  promotions: readonly Promotion[],
  now: Date,
  timeZone: string,
  branchId: string,
): MenuView {
  const live = promotions.filter((p) => isPromotionLive(p, now, timeZone, branchId));
  if (live.length === 0) return menu;
  const parent = new Map(menu.categories.map((c) => [c.id, c.parentId]));
  const pathOf = (categoryId: string) => {
    const path: string[] = [];
    for (let c: string | null | undefined = categoryId; c && !path.includes(c); c = parent.get(c))
      path.push(c);
    return path;
  };
  const currency = menu.currency;
  const products = menu.products.map((p) => {
    const bundle = live.find(
      (x) => x.kind === 'bundle_price' && promotionCovers(x, p.id, pathOf(p.categoryId)),
    );
    const quantity = bundle ? (bundle.bundleQuantity ?? 1) : 1;
    const chosen = choosePromotion(live, {
      productId: p.id,
      categoryPath: pathOf(p.categoryId),
      basePrice: p.price,
      quantity,
    });
    if (!chosen) return p;
    const promo = live.find((x) => x.id === chosen.id)!;
    const price = Math.round((p.price * quantity - chosen.discount) / quantity);
    const label =
      promo.kind === 'bundle_price'
        ? `${quantity} for ${formatMinor(promo.amount ?? 0, currency)}`
        : promo.kind === 'percent_off'
          ? `${(promo.percentBp ?? 0) / 100}% off`
          : `${formatMinor(price, currency)}`;
    return {
      ...p,
      promotion: {
        id: chosen.id,
        name: chosen.name,
        price,
        label,
        minQuantity: quantity,
        saving: chosen.discount,
      },
    };
  });
  const tag = live.map((p) => p.id.slice(0, 8)).join('');
  return { ...menu, products, version: `${menu.version}-${tag}` };
}
