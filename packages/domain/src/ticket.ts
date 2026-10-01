import type { OrderItemStatus, TicketStatus } from './enums';
import { DomainError } from './errors';

export const TICKET_ACTIONS = ['accept', 'start', 'pause', 'resume', 'ready', 'recall', 'complete'] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

/**
 * Kitchen workflow: NEW -> ACCEPT -> START -> READY -> DONE (complete). ACCEPT means "the kitchen
 * has received this order"; it is not START ("cooking has begun"). Each is a separate step.
 */
const TRANSITIONS: Record<TicketAction, { from: readonly TicketStatus[]; to: TicketStatus }> = {
  accept: { from: ['new'], to: 'accepted' },
  start: { from: ['accepted'], to: 'in_preparation' },
  pause: { from: ['accepted', 'in_preparation'], to: 'on_hold' },
  resume: { from: ['on_hold'], to: 'in_preparation' },
  ready: { from: ['in_preparation', 'on_hold'], to: 'ready' },
  recall: { from: ['ready', 'completed'], to: 'in_preparation' },
  complete: { from: ['ready'], to: 'completed' },
};

/** What the kitchen must press first, when an action comes too early. */
const FIRST: Partial<Record<TicketStatus, string>> = { new: 'ACCEPT', accepted: 'START' };

/**
 * `expedite`: a supervisor marks a whole order ready (counters without a kitchen screen): READY is
 * then allowed from NEW or ACCEPTED, and no accept/start time is invented.
 */
export function nextTicketStatus(
  current: TicketStatus,
  action: TicketAction,
  options: { expedite?: boolean } = {},
): TicketStatus {
  if (options.expedite && action === 'ready' && (current === 'new' || current === 'accepted')) return 'ready';
  const rule = TRANSITIONS[action];
  if ((action === 'start' || action === 'ready') && FIRST[current] && !rule.from.includes(current)) {
    throw new DomainError('INVALID_TRANSITION', `Press ${FIRST[current]} first`, { current, action });
  }
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
