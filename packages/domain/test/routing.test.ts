import { describe, expect, it } from 'vitest';
import { groupByStation, type RoutingConfig, type RoutingRule, resolveRoute } from '../src';

const rule = (r: Partial<RoutingRule> & Pick<RoutingRule, 'id' | 'match' | 'stationId'>): RoutingRule => ({
  productId: null,
  categoryId: null,
  areaId: null,
  priority: 0,
  ...r,
});

const config = (rules: RoutingRule[], reachable = ['KIT', 'GRL', 'PAS', 'DRK', 'BAR']): RoutingConfig => ({
  rules,
  categoryParents: new Map([
    ['food', null],
    ['grills', 'food'],
    ['sandwiches', 'food'],
    ['pastries', null],
    ['cakes', 'pastries'],
  ]),
  reachableStationIds: new Set(reachable),
});

const base = [
  rule({ id: 'r-food', match: 'category', categoryId: 'food', stationId: 'KIT' }),
  rule({ id: 'r-grills', match: 'category', categoryId: 'grills', stationId: 'GRL' }),
  rule({ id: 'r-pastries', match: 'category', categoryId: 'pastries', stationId: 'PAS' }),
  rule({ id: 'r-default', match: 'default', stationId: 'KIT' }),
];
const item = (productId: string, categoryId: string) => ({ itemId: `i-${productId}`, productId, categoryId });

describe('routing precedence', () => {
  it('uses the nearest category rule, walking up the tree', () => {
    expect(resolveRoute(item('chicken', 'grills'), 'hall', config(base)).stationId).toBe('GRL');
    expect(resolveRoute(item('sandwich', 'sandwiches'), 'hall', config(base)).stationId).toBe('KIT');
    expect(resolveRoute(item('cake', 'cakes'), 'hall', config(base)).stationId).toBe('PAS');
  });

  it('a product rule beats any category rule', () => {
    const rules = [...base, rule({ id: 'r-p', match: 'product', productId: 'chicken', stationId: 'KIT' })];
    expect(resolveRoute(item('chicken', 'grills'), 'hall', config(rules))).toMatchObject({
      stationId: 'KIT',
      match: 'product',
    });
  });

  it('an area-specific rule beats a generic one, and only applies to that area', () => {
    const rules = [
      ...base,
      rule({ id: 'r-bar', match: 'category', categoryId: 'grills', areaId: 'takeaway', stationId: 'BAR' }),
    ];
    expect(resolveRoute(item('chicken', 'grills'), 'takeaway', config(rules)).stationId).toBe('BAR');
    expect(resolveRoute(item('chicken', 'grills'), 'hall', config(rules)).stationId).toBe('GRL');
  });

  it('higher priority wins within a level; ties break deterministically by id', () => {
    const rules = [
      rule({ id: 'b', match: 'category', categoryId: 'grills', stationId: 'GRL' }),
      rule({ id: 'a', match: 'category', categoryId: 'grills', stationId: 'KIT' }),
      rule({ id: 'c', match: 'category', categoryId: 'grills', stationId: 'BAR', priority: 5 }),
    ];
    expect(resolveRoute(item('chicken', 'grills'), 'hall', config(rules)).stationId).toBe('BAR');
    expect(resolveRoute(item('chicken', 'grills'), 'hall', config(rules.slice(0, 2))).stationId).toBe('KIT');
  });

  it('skips rules whose station cannot receive work and falls back', () => {
    expect(resolveRoute(item('chicken', 'grills'), 'hall', config(base, ['KIT'])).stationId).toBe('KIT');
  });

  it('refuses to route when nothing is reachable', () => {
    expect(() => resolveRoute(item('chicken', 'grills'), 'hall', config(base, []))).toThrow(
      expect.objectContaining({ code: 'NO_ROUTE' }),
    );
  });

  it('survives a category cycle in bad data', () => {
    const cfg = config([rule({ id: 'd', match: 'default', stationId: 'KIT' })]);
    (cfg.categoryParents as Map<string, string | null>).set('x', 'y').set('y', 'x');
    expect(resolveRoute(item('p', 'x'), 'hall', cfg).stationId).toBe('KIT');
  });

  it('groups decisions by station preserving order', () => {
    const groups = groupByStation([
      { itemId: '1', stationId: 'A', ruleId: 'r', match: 'default' },
      { itemId: '2', stationId: 'B', ruleId: 'r', match: 'default' },
      { itemId: '3', stationId: 'A', ruleId: 'r', match: 'default' },
    ]);
    expect([...groups.keys()]).toEqual(['A', 'B']);
    expect(groups.get('A')!.map((d) => d.itemId)).toEqual(['1', '3']);
  });
});
