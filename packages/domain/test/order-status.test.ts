import { describe, expect, it } from 'vitest';
import {
  deriveOrderStatus,
  type OrderItemStatus,
  type PaymentStatus,
  planFulfilment,
  priceNewItem,
} from '../src';

const items = (...s: OrderItemStatus[]) => s.map((status) => ({ status }));
const derive = (
  s: OrderItemStatus[],
  pay: PaymentStatus = 'unpaid',
  channel: 'dine_in' | 'takeaway' = 'dine_in',
) => deriveOrderStatus('submitted', channel, items(...s), pay);

describe('order status is derived, never declared', () => {
  it.each([
    [['pending', 'pending'], 'draft'],
    [['sent', 'sent'], 'submitted'],
    [['accepted', 'sent'], 'submitted'],
    [['in_preparation', 'sent'], 'in_preparation'],
    [['ready', 'in_preparation'], 'partially_ready'],
    [['ready', 'sent'], 'partially_ready'],
    [['ready', 'ready'], 'ready'],
    [['served', 'ready'], 'ready'],
    [['served', 'served'], 'served'],
    [['ready', 'voided'], 'ready'],
    [['served', 'pending'], 'served'],
  ] as [OrderItemStatus[], string][])('%j -> %s', (s, expected) => {
    expect(derive(s)).toBe(expected);
  });

  it('kitchen readiness, fulfilment and payment are independent', () => {
    expect(derive(['ready', 'ready'], 'paid')).toBe('ready'); // paid + ready is not completed
    expect(derive(['served'], 'unpaid')).toBe('served');
    expect(derive(['served'], 'unpaid', 'takeaway')).toBe('picked_up');
    expect(derive(['served'], 'paid', 'takeaway')).toBe('completed');
    expect(derive(['served'], 'partially_paid')).toBe('served');
    expect(derive(['served'], 'refunded')).toBe('completed');
  });

  it('cancelled and voided orders stay terminal', () => {
    expect(deriveOrderStatus('cancelled', 'dine_in', items('ready'), 'paid')).toBe('cancelled');
    expect(deriveOrderStatus('voided', 'dine_in', items('served'), 'paid')).toBe('voided');
  });
});

describe('pricing a line', () => {
  const product = {
    id: 'p',
    categoryId: 'c',
    name: 'Jollof Rice',
    kitchenName: 'JOLLOF',
    price: 4500,
    isAvailable: true,
    requiresPreparation: true,
    taxes: [],
    modifierGroups: [
      {
        id: 'spice',
        name: 'Spice',
        minSelect: 1,
        maxSelect: 1,
        modifiers: [
          { id: 'hot', name: 'Hot', priceDelta: 0 },
          { id: 'mild', name: 'Mild', priceDelta: 0 },
        ],
      },
      {
        id: 'extra',
        name: 'Extras',
        minSelect: 0,
        maxSelect: null,
        modifiers: [{ id: 'chk', name: 'Extra chicken', priceDelta: 1000 }],
      },
    ],
  };
  it('adds modifier prices per unit', () => {
    const line = priceNewItem(
      { id: 'i', productId: 'p', quantity: 2, modifierIds: ['hot', 'chk'], notes: ' no onions ' },
      product,
    );
    expect(line.lineTotal).toBe(2 * (4500 + 1000));
    expect(line.notes).toBe('no onions');
  });
  it('enforces modifier group rules and quantity', () => {
    expect(() =>
      priceNewItem({ id: 'i', productId: 'p', quantity: 1, modifierIds: [], notes: null }, product),
    ).toThrow(/at least 1/);
    expect(() =>
      priceNewItem(
        { id: 'i', productId: 'p', quantity: 1, modifierIds: ['hot', 'mild'], notes: null },
        product,
      ),
    ).toThrow(/at most 1/);
    expect(() =>
      priceNewItem(
        { id: 'i', productId: 'p', quantity: 1, modifierIds: ['hot', 'nope'], notes: null },
        product,
      ),
    ).toThrow(/does not belong/);
    expect(() =>
      priceNewItem({ id: 'i', productId: 'p', quantity: 0, modifierIds: ['hot'], notes: null }, product),
    ).toThrow(/quantity/);
    expect(() =>
      priceNewItem(
        { id: 'i', productId: 'p', quantity: 1, modifierIds: ['hot'], notes: null },
        { ...product, isAvailable: false },
      ),
    ).toThrow(expect.objectContaining({ code: 'PRODUCT_UNAVAILABLE' }));
  });
});

describe('fulfilment', () => {
  it('hands over only ready items', () => {
    const list = [
      { id: 'a', status: 'ready' },
      { id: 'b', status: 'in_preparation' },
    ] as Parameters<typeof planFulfilment>[0];
    expect(planFulfilment(list)).toEqual(['a']);
    expect(() => planFulfilment(list, ['b'])).toThrow(/ready/);
  });
});
