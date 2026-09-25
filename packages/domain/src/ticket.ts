import type { OrderItemStatus, TicketStatus } from './enums';
import { DomainError } from './errors';

export const TICKET_ACTIONS = ['accept', 'start', 'pause', 'resume', 'ready', 'recall', 'complete'] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

const TRANSITIONS: Record<TicketAction, { from: readonly TicketStatus[]; to: TicketStatus }> = {
  accept: { from: ['new'], to: 'accepted' },
  start: { from: ['new', 'accepted'], to: 'in_preparation' },
  pause: { from: ['accepted', 'in_preparation'], to: 'on_hold' },
  resume: { from: ['on_hold'], to: 'in_preparation' },
  ready: { from: ['new', 'accepted', 'in_preparation', 'on_hold'], to: 'ready' },
  recall: { from: ['ready', 'completed'], to: 'in_preparation' },
  complete: { from: ['ready'], to: 'completed' },
};

export function nextTicketStatus(current: TicketStatus, action: TicketAction): TicketStatus {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(current)) {
    throw new DomainError(
      'INVALID_TRANSITION',
      `Cannot ${action} a ticket that is ${current.replace('_', ' ')}`,
      {
        current,
        action,
      },
    );
  }
  return rule.to;
}

/** How a ticket action moves the items on it. Cancelled, voided and served items never move. */
export function itemStatusAfter(action: TicketAction, item: OrderItemStatus): OrderItemStatus {
  if (item === 'cancelled' || item === 'voided' || item === 'served') return item;
  switch (action) {
    case 'accept':
      return item === 'sent' ? 'accepted' : item;
    case 'start':
    case 'resume':
      return item === 'sent' || item === 'accepted' ? 'in_preparation' : item;
    case 'ready':
      return item === 'pending' ? item : 'ready';
    case 'recall':
      return item === 'ready' ? 'in_preparation' : item;
    case 'pause':
    case 'complete':
      return item;
  }
}

export function assertRecallAllowed(items: readonly OrderItemStatus[]): void {
  if (items.includes('served')) {
    throw new DomainError(
      'INVALID_TRANSITION',
      'Items on this ticket were already served and cannot be recalled',
    );
  }
}

/** After items are handed over, a ticket whose active items are all served is finished. */
export function ticketStatusAfterFulfilment(
  current: TicketStatus,
  items: readonly OrderItemStatus[],
): TicketStatus {
  const active = items.filter((s) => s !== 'cancelled' && s !== 'voided');
  if (active.length > 0 && active.every((s) => s === 'served') && current !== 'cancelled') return 'completed';
  return current;
}
