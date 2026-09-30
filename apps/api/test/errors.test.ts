import { DomainError } from '@rp/domain';
import { describe, expect, it } from 'vitest';
import { toHttpError } from '../src/http/errors';

/** Refusals must say why (production, 2026-09-30: a blocked branch was shown as a "permission" problem). */
describe('refusals shown to staff', () => {
  const message = (error: DomainError) => toHttpError(error, 'submit_order', 'c-1').body.error.message;

  it('a missing permission names what the role cannot do', () => {
    expect(
      message(
        new DomainError('FORBIDDEN', 'You do not have permission to do this', {
          permission: 'order.create',
          branchId: 'b',
        }),
      ),
    ).toBe(
      'Your role does not allow you to take orders. An owner can change this in Staff, Roles & permissions.',
    );
  });

  it('any other refusal is shown as written', () => {
    expect(
      message(
        new DomainError(
          'FORBIDDEN',
          "This branch is run by its MY FOOD Hub: open MY FOOD at the Hub's address on this till, or a manager presses Stop running branch in Devices & printing.",
          { reason: 'branch_run_by_hub' },
        ),
      ),
    ).toBe(
      "This branch is run by its MY FOOD Hub: open MY FOOD at the Hub's address on this till, or a manager presses Stop running branch in Devices & printing.",
    );
    expect(message(new DomainError('FORBIDDEN', 'This sign-in belongs to another device'))).toBe(
      'This sign-in belongs to another device.',
    );
  });

  it('stays a 403 and is not retryable', () => {
    const r = toHttpError(new DomainError('FORBIDDEN', 'Unknown device'), 'submit_order', 'c-1');
    expect(r.status).toBe(403);
    expect(r.body.error.retryable).toBe(false);
  });
});
