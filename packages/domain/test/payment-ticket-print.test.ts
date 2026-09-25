import { describe, expect, it } from 'vitest';
import {
  applyPrintOutcome,
  businessDay,
  derivePaymentStatus,
  itemStatusAfter,
  kitchenTicketDocument,
  nextTicketStatus,
  PRINT_RETRY_POLICY,
  planPayment,
  planRefund,
  summarizePayments,
} from '../src';

describe('payment planning', () => {
  it('cash: tendered above balance produces change', () => {
    expect(planPayment(15000, { method: 'cash', tendered: 20000 })).toEqual({
      amount: 15000,
      tendered: 20000,
      change: 5000,
    });
    expect(planPayment(15000, { method: 'cash', tendered: 5000 })).toEqual({
      amount: 5000,
      tendered: 5000,
      change: 0,
    });
    expect(planPayment(15000, { method: 'cash', amount: 10000, tendered: 10000 })).toEqual({
      amount: 10000,
      tendered: 10000,
      change: 0,
    });
  });
  it('non-cash cannot exceed the balance and has no tender', () => {
    expect(planPayment(15000, { method: 'momo', amount: 5000 })).toEqual({
      amount: 5000,
      tendered: null,
      change: 0,
    });
    expect(() => planPayment(15000, { method: 'card', amount: 15001 })).toThrow(
      expect.objectContaining({ code: 'PAYMENT_EXCEEDS_BALANCE' }),
    );
    expect(() => planPayment(15000, { method: 'card', amount: 100, tendered: 100 })).toThrow();
    expect(() => planPayment(0, { method: 'card', amount: 100 })).toThrow(
      expect.objectContaining({ code: 'ORDER_ALREADY_PAID' }),
    );
  });
  it('status follows the money', () => {
    const rec = (
      amount: number,
      direction: 'charge' | 'refund' = 'charge',
      status: 'recorded' | 'voided' = 'recorded',
    ) => ({
      id: String(Math.random()),
      direction,
      method: 'cash' as const,
      amount,
      status,
      refundOfPaymentId: direction === 'refund' ? 'x' : null,
    });
    expect(derivePaymentStatus(15000, summarizePayments([]), true)).toBe('unpaid');
    expect(derivePaymentStatus(15000, summarizePayments([rec(10000)]), true)).toBe('partially_paid');
    expect(derivePaymentStatus(15000, summarizePayments([rec(10000), rec(5000)]), true)).toBe('paid');
    expect(derivePaymentStatus(15000, summarizePayments([rec(15000, 'charge', 'voided')]), true)).toBe(
      'unpaid',
    );
    expect(derivePaymentStatus(15000, summarizePayments([rec(15000), rec(5000, 'refund')]), true)).toBe(
      'partially_refunded',
    );
    expect(derivePaymentStatus(15000, summarizePayments([rec(15000), rec(15000, 'refund')]), true)).toBe(
      'refunded',
    );
    expect(derivePaymentStatus(0, summarizePayments([]), true)).toBe('paid');
    expect(derivePaymentStatus(0, summarizePayments([]), false)).toBe('unpaid');
  });
  it('refunds are capped by what is left of the payment', () => {
    const p = {
      id: 'p',
      direction: 'charge' as const,
      method: 'cash' as const,
      amount: 10000,
      status: 'recorded' as const,
      refundOfPaymentId: null,
    };
    expect(planRefund(p, 4000, 6000)).toBe(6000);
    expect(() => planRefund(p, 4000, 6001)).toThrow(
      expect.objectContaining({ code: 'REFUND_EXCEEDS_PAYMENT' }),
    );
  });
});

describe('ticket state machine', () => {
  it('allows the kitchen flow and rejects nonsense', () => {
    expect(nextTicketStatus('new', 'start')).toBe('in_preparation');
    expect(nextTicketStatus('in_preparation', 'pause')).toBe('on_hold');
    expect(nextTicketStatus('ready', 'recall')).toBe('in_preparation');
    expect(nextTicketStatus('ready', 'complete')).toBe('completed');
    expect(() => nextTicketStatus('completed', 'start')).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    );
  });
  it('moves items with the ticket but never touches served or voided items', () => {
    expect(itemStatusAfter('ready', 'in_preparation')).toBe('ready');
    expect(itemStatusAfter('ready', 'voided')).toBe('voided');
    expect(itemStatusAfter('recall', 'served')).toBe('served');
    expect(itemStatusAfter('start', 'sent')).toBe('in_preparation');
  });
});

describe('print retry policy', () => {
  const job = {
    status: 'claimed' as const,
    attempts: 0,
    maxAttempts: 8,
    printerId: 'P',
    originalPrinterId: 'P',
    possibleDuplicate: false,
  };
  const now = new Date('2026-09-25T12:00:00Z');

  it('backs off, reroutes to backup, then dies', () => {
    let state = { ...job };
    const seen: string[] = [];
    for (let i = 0; i < PRINT_RETRY_POLICY.maxAttempts; i++) {
      const next = applyPrintOutcome(state, 'failed_before_send', now, 'B');
      seen.push(`${next.status}@${next.printerId}`);
      state = {
        ...state,
        status: next.status as 'claimed',
        attempts: next.attempts,
        printerId: next.printerId,
      };
    }
    expect(seen[0]).toBe('failed@P');
    expect(seen[2]).toBe('failed@B'); // rerouted after 3 attempts
    expect(seen.at(-1)).toBe('dead@B');
  });
  it('marks possible duplicates when bytes may have reached the printer', () => {
    expect(applyPrintOutcome(job, 'failed_after_send', now, null).possibleDuplicate).toBe(true);
    expect(applyPrintOutcome(job, 'lease_expired', now, null).possibleDuplicate).toBe(true);
    expect(applyPrintOutcome(job, 'failed_before_send', now, null).possibleDuplicate).toBe(false);
  });
  it('schedules the first retry after the first backoff step', () => {
    const next = applyPrintOutcome(job, 'failed_before_send', now, null);
    expect(next.nextAttemptAt!.getTime() - now.getTime()).toBe(PRINT_RETRY_POLICY.backoffSeconds[0]! * 1000);
  });
});

describe('business day', () => {
  it('assigns early-morning sales to the previous trading day', () => {
    expect(businessDay(new Date('2026-09-25T01:30:00Z'), 'Africa/Accra', '04:00')).toBe('2026-09-24');
    expect(businessDay(new Date('2026-09-25T04:00:00Z'), 'Africa/Accra', '04:00')).toBe('2026-09-25');
    // 23:00Z is 00:00 on the 26th in Lagos (UTC+1): before the cutoff, so still the 25th's trading day.
    expect(businessDay(new Date('2026-09-25T23:00:00Z'), 'Africa/Lagos', '04:00')).toBe('2026-09-25');
    expect(businessDay(new Date('2026-09-26T03:30:00Z'), 'Africa/Lagos', '04:00')).toBe('2026-09-26');
  });
});

describe('kitchen ticket document', () => {
  it('carries order number, table and items without printer bytes', () => {
    const doc = kitchenTicketDocument({
      stationName: 'Grill',
      orderNumber: 5001,
      channel: 'dine_in',
      areaName: 'Hall',
      tableLabel: '12',
      customerName: null,
      orderNotes: null,
      createdAt: new Date('2026-09-25T15:42:00Z'),
      timeZone: 'Africa/Accra',
      submissionSeq: 1,
      ticketId: 'abcdef12-0000',
      items: [{ quantity: 2, name: 'Grilled Chicken', modifiers: ['NO PEPPER'], notes: null }],
    });
    const text = doc.blocks.flatMap((b) => ('text' in b ? [b.text] : 'left' in b ? [b.left] : []));
    expect(text).toContain('ORDER #5001');
    expect(text).toContain('HALL - TABLE 12');
    expect(text).toContain('2 x GRILLED CHICKEN');
    expect(text).toContain('15:42');
  });
});
