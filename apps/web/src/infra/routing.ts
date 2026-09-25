import type { ConfigurationView } from '@rp/contracts';
import { type RoutingConfig, type RoutingRule, resolveRoute } from '@rp/domain';

type Row = Record<string, unknown>;

/**
 * Explains routing with the SAME domain function the server uses when an order is sent,
 * so "where does this item go?" on screen is exactly what the kitchen will receive.
 */
export function routingFrom(config: ConfigurationView): RoutingConfig {
  const outputs = config.stationOutputs as Row[];
  const devices = new Map((config.devices as Row[]).map((d) => [d.id as string, d]));
  const reachable = new Set(
    (config.stations as Row[])
      .filter((s) => s.isActive)
      .filter((s) => outputs.some((o) => o.stationId === s.id && devices.get(o.deviceId as string)?.isActive))
      .map((s) => s.id as string),
  );
  return {
    rules: (config.routingRules as Row[])
      .filter((r) => r.isActive)
      .map(
        (r): RoutingRule => ({
          id: r.id as string,
          match: r.match as RoutingRule['match'],
          productId: (r.productId ?? null) as string | null,
          categoryId: (r.categoryId ?? null) as string | null,
          areaId: (r.areaId ?? null) as string | null,
          stationId: r.stationId as string,
          priority: Number(r.priority ?? 0),
        }),
      ),
    categoryParents: new Map(
      (config.categories as Row[]).map((c) => [c.id as string, (c.parentId ?? null) as string | null]),
    ),
    reachableStationIds: reachable,
  };
}

export interface RouteExplanation {
  stationId: string | null;
  stationName: string;
  because: string;
  outputs: string[];
}

export function explainRoute(
  config: ConfigurationView,
  routing: RoutingConfig,
  product: { id: string; categoryId: string },
  areaId: string,
): RouteExplanation {
  const stations = new Map((config.stations as Row[]).map((s) => [s.id as string, s]));
  const categories = new Map((config.categories as Row[]).map((c) => [c.id as string, c]));
  try {
    const d = resolveRoute(
      { itemId: product.id, productId: product.id, categoryId: product.categoryId },
      areaId,
      routing,
    );
    const rule = routing.rules.find((r) => r.id === d.ruleId);
    const because =
      d.match === 'product'
        ? 'product rule'
        : d.match === 'category'
          ? `category “${String(categories.get(rule?.categoryId ?? '')?.name ?? '')}”`
          : 'default station';
    const outputs = (config.stationOutputs as Row[])
      .filter((o) => o.stationId === d.stationId)
      .map((o) => (config.devices as Row[]).find((dv) => dv.id === o.deviceId))
      .filter((dv): dv is Row => Boolean(dv?.isActive))
      .map((dv) => `${dv.kind === 'kds' ? 'Screen' : 'Printer'} ${String(dv.name)}`);
    return {
      stationId: d.stationId,
      stationName: String(stations.get(d.stationId)?.name ?? ''),
      because,
      outputs,
    };
  } catch {
    return {
      stationId: null,
      stationName: 'Not routed',
      because: 'no rule reaches a working station',
      outputs: [],
    };
  }
}
