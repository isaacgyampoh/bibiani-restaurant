import type { RoutingMatch } from './enums';
import { DomainError } from './errors';

export interface RoutingRule {
  id: string;
  match: RoutingMatch;
  productId: string | null;
  categoryId: string | null;
  areaId: string | null;
  stationId: string;
  priority: number;
}

export interface RoutingConfig {
  rules: readonly RoutingRule[];
  /** categoryId -> parentId (null for roots). */
  categoryParents: ReadonlyMap<string, string | null>;
  /** Stations that are active AND have at least one active output (printer or KDS). */
  reachableStationIds: ReadonlySet<string>;
}

export interface RoutableItem {
  itemId: string;
  productId: string;
  categoryId: string;
}

export interface RouteDecision {
  itemId: string;
  stationId: string;
  ruleId: string;
  match: RoutingMatch;
}

/**
 * Resolves the production station for one item.
 * Precedence: product rule > category rule (nearest category first, walking up
 * the tree) > branch default. Within a level: rules for this operational area
 * beat area-agnostic rules, then higher priority, then rule id (deterministic).
 * Rules pointing at unreachable stations are skipped so an item never lands on
 * a station nobody can see or print.
 */
export function resolveRoute(item: RoutableItem, areaId: string, config: RoutingConfig): RouteDecision {
  const pick = (candidates: RoutingRule[]): RoutingRule | undefined =>
    candidates
      .filter(
        (r) => (r.areaId === null || r.areaId === areaId) && config.reachableStationIds.has(r.stationId),
      )
      .sort(
        (a, b) =>
          Number(b.areaId !== null) - Number(a.areaId !== null) ||
          b.priority - a.priority ||
          a.id.localeCompare(b.id),
      )[0];

  const decide = (rule: RoutingRule): RouteDecision => ({
    itemId: item.itemId,
    stationId: rule.stationId,
    ruleId: rule.id,
    match: rule.match,
  });

  const productRule = pick(
    config.rules.filter((r) => r.match === 'product' && r.productId === item.productId),
  );
  if (productRule) return decide(productRule);

  const visited = new Set<string>();
  let categoryId: string | null | undefined = item.categoryId;
  while (categoryId && !visited.has(categoryId)) {
    visited.add(categoryId);
    const current: string = categoryId;
    const categoryRule = pick(config.rules.filter((r) => r.match === 'category' && r.categoryId === current));
    if (categoryRule) return decide(categoryRule);
    categoryId = config.categoryParents.get(current) ?? null;
  }

  const defaultRule = pick(config.rules.filter((r) => r.match === 'default'));
  if (defaultRule) return decide(defaultRule);

  throw new DomainError('NO_ROUTE', 'No production station is configured for this item', {
    itemId: item.itemId,
    productId: item.productId,
    areaId,
  });
}

/** Groups decisions by station, preserving first-seen order of stations and items. */
export function groupByStation(decisions: readonly RouteDecision[]): Map<string, RouteDecision[]> {
  const groups = new Map<string, RouteDecision[]>();
  for (const d of decisions) {
    const group = groups.get(d.stationId);
    if (group) group.push(d);
    else groups.set(d.stationId, [d]);
  }
  return groups;
}
