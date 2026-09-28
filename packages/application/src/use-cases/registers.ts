import type {
  CloseRegisterCommand,
  OpenRegisterCommand,
  RegisterListView,
  RegisterSessionView,
  ReopenRegisterCommand,
} from '@rp/contracts';
import { DomainError, registerTotals, registerVariance } from '@rp/domain';
import type { RegisterRecord, Repositories } from '../ports';
import { authorize, can, type RequestContext } from '../principal';
import type { Dependencies } from './shared';

/**
 * Cash registers. A cashier opens their register on a terminal with the opening float; every
 * payment they record while it is open is attached to it. Closing records the counted cash;
 * expected cash (float + cash taken − cash refunded) and the variance are computed and stored
 * with the close. Nothing is adjusted to match the count. A closed register cannot be edited;
 * a manager (register.manage) may reopen it, with a reason, and that is audited.
 */
async function view(tx: Repositories, r: RegisterRecord, currency: string): Promise<RegisterSessionView> {
  const [payments, orders] = await Promise.all([tx.registers.payments(r.id), tx.registers.orderCounts(r.id)]);
  const live = registerTotals(r.openingCash, payments);
  // Once closed, the figures are the ones recorded at the close (later payment voids do not rewrite it).
  const totals = r.status === 'closed' && r.closingTotals ? r.closingTotals : live;
  return {
    id: r.id,
    branchId: r.branchId,
    status: r.status,
    terminalName: r.terminalName,
    deviceId: r.deviceId,
    cashierStaffId: r.cashierStaffId,
    cashierName: r.cashierName,
    openedAt: r.openedAt.toISOString(),
    openingCash: r.openingCash,
    openingNote: r.openingNote,
    cashSales: totals.cashSales,
    cashRefunds: totals.cashRefunds,
    expectedCash: r.status === 'closed' && r.expectedCash !== null ? r.expectedCash : totals.expectedCash,
    byMethod: totals.byMethod,
    totalNet: totals.totalNet,
    payments: payments.filter((p) => p.direction === 'charge').length,
    orders,
    closedAt: r.closedAt?.toISOString() ?? null,
    closedByName: r.closedByName,
    countedCash: r.countedCash,
    variance: r.variance,
    closingNote: r.closingNote,
    reopenCount: r.reopenCount,
    reopenedAt: r.reopenedAt?.toISOString() ?? null,
    reopenReason: r.reopenReason,
    version: r.version,
    currency,
  };
}

/** Only the cashier themself or someone with register.manage may see or close a register. */
function assertMine(ctx: RequestContext, r: RegisterRecord): void {
  if (r.cashierStaffId === ctx.principal.staffId && can(ctx.principal, 'register.operate', r.branchId))
    return;
  authorize(ctx.principal, 'register.manage', r.branchId);
}

export class OpenRegister {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, cmd: OpenRegisterCommand): Promise<RegisterSessionView> {
    authorize(ctx.principal, 'register.operate', cmd.branchId);
    const staffId = ctx.principal.staffId;
    if (!staffId) throw new DomainError('FORBIDDEN', 'Sign in as a staff member to open a register');
    const now = this.deps.clock.now();
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const currency = await tx.customers.currency();
      const again = await tx.registers.find(cmd.sessionId);
      if (again) {
        if (again.cashierStaffId !== staffId || again.openingCash !== cmd.openingCash)
          throw new DomainError('IDEMPOTENCY_MISMATCH', 'This register id was already used');
        return view(tx, again, currency);
      }
      const mine = await tx.registers.openFor(cmd.branchId, staffId);
      if (mine)
        throw new DomainError('REGISTER_OPEN', 'You already have an open register. Close it first.', {
          sessionId: mine.id,
        });
      if (ctx.deviceId) {
        const onDevice = await tx.registers.openOnDevice(ctx.deviceId);
        if (onDevice)
          throw new DomainError(
            'REGISTER_OPEN',
            `${onDevice.cashierName} has a register open on this terminal. It must be closed first.`,
            { sessionId: onDevice.id },
          );
      }
      const names = await tx.registers.names(staffId, ctx.deviceId);
      await tx.registers.insert({
        id: cmd.sessionId,
        branchId: cmd.branchId,
        deviceId: ctx.deviceId,
        terminalName: names.device ?? 'Back office',
        cashierStaffId: staffId,
        cashierName: names.staff ?? 'Staff',
        openingCash: cmd.openingCash,
        openingNote: cmd.note?.trim() || null,
        openedAt: now,
      });
      await tx.audit.append({
        branchId: cmd.branchId,
        actorStaffId: staffId,
        actorDeviceId: ctx.deviceId,
        action: 'register.open',
        entityType: 'register',
        entityId: cmd.sessionId,
        after: { openingCash: cmd.openingCash, terminal: names.device ?? 'Back office' },
        correlationId: ctx.correlationId,
      });
      return view(tx, (await tx.registers.find(cmd.sessionId))!, currency);
    });
  }
}

/** The signed-in cashier's open register in a branch, or null. */
export class GetCurrentRegister {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, branchId: string): Promise<RegisterSessionView | null> {
    authorize(ctx.principal, 'register.operate', branchId);
    const staffId = ctx.principal.staffId;
    if (!staffId) return null;
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const r = await tx.registers.openFor(branchId, staffId);
      return r ? view(tx, r, await tx.customers.currency()) : null;
    });
  }
}

export class GetRegister {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, sessionId: string): Promise<RegisterSessionView> {
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const r = await tx.registers.find(sessionId);
      if (!r) throw new DomainError('NOT_FOUND', 'Register not found');
      assertMine(ctx, r);
      return view(tx, r, await tx.customers.currency());
    });
  }
}

/** Registers of a branch: managers see all; a cashier sees their own. */
export class ListRegisters {
  constructor(private readonly deps: Dependencies) {}

  async execute(
    ctx: RequestContext,
    branchId: string,
    q: { from?: string | null; to?: string | null },
  ): Promise<RegisterListView> {
    const all = can(ctx.principal, 'register.manage', branchId);
    if (!all) authorize(ctx.principal, 'register.operate', branchId);
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const currency = await tx.customers.currency();
      const records = await tx.registers.list({
        branchId,
        staffId: all ? null : ctx.principal.staffId,
        from: q.from ?? null,
        to: q.to ?? null,
      });
      return { sessions: await Promise.all(records.map((r) => view(tx, r, currency))), currency };
    });
  }
}

export class CloseRegister {
  constructor(private readonly deps: Dependencies) {}

  async execute(
    ctx: RequestContext,
    sessionId: string,
    cmd: CloseRegisterCommand,
  ): Promise<RegisterSessionView> {
    const now = this.deps.clock.now();
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const r = await tx.registers.find(sessionId, true);
      if (!r) throw new DomainError('NOT_FOUND', 'Register not found');
      assertMine(ctx, r);
      const currency = await tx.customers.currency();
      if (r.status === 'closed') {
        // The same close sent twice (double tap, retry) returns the recorded close; anything else is refused.
        if (r.countedCash === cmd.countedCash && r.version === cmd.version + 1) return view(tx, r, currency);
        throw new DomainError('REGISTER_CLOSED', 'This register is already closed');
      }
      const totals = registerTotals(r.openingCash, await tx.registers.payments(sessionId));
      const variance = registerVariance(totals.expectedCash, cmd.countedCash);
      const closed = await tx.registers.close(
        sessionId,
        {
          closedAt: now,
          staffId: ctx.principal.staffId,
          totals,
          countedCash: cmd.countedCash,
          variance,
          note: cmd.note?.trim() || null,
        },
        cmd.version,
      );
      if (!closed)
        throw new DomainError('VERSION_CONFLICT', 'This register changed. Check the totals and close again.');
      await tx.audit.append({
        branchId: r.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'register.close',
        entityType: 'register',
        entityId: sessionId,
        after: {
          cashier: r.cashierName,
          terminal: r.terminalName,
          openingCash: r.openingCash,
          cashSales: totals.cashSales,
          cashRefunds: totals.cashRefunds,
          expectedCash: totals.expectedCash,
          countedCash: cmd.countedCash,
          variance,
        },
        reason: cmd.note?.trim() || null,
        correlationId: ctx.correlationId,
      });
      return view(tx, (await tx.registers.find(sessionId))!, currency);
    });
  }
}

export class ReopenRegister {
  constructor(private readonly deps: Dependencies) {}

  async execute(
    ctx: RequestContext,
    sessionId: string,
    cmd: ReopenRegisterCommand,
  ): Promise<RegisterSessionView> {
    const now = this.deps.clock.now();
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const r = await tx.registers.find(sessionId, true);
      if (!r) throw new DomainError('NOT_FOUND', 'Register not found');
      authorize(ctx.principal, 'register.manage', r.branchId);
      if (r.status !== 'closed') throw new DomainError('INVALID_TRANSITION', 'This register is not closed');
      if (await tx.registers.openFor(r.branchId, r.cashierStaffId))
        throw new DomainError('REGISTER_OPEN', `${r.cashierName} already has another register open`);
      if (r.deviceId && (await tx.registers.openOnDevice(r.deviceId)))
        throw new DomainError('REGISTER_OPEN', 'Another register is open on this terminal');
      if (
        !(await tx.registers.reopen(
          sessionId,
          { at: now, staffId: ctx.principal.staffId, reason: cmd.reason },
          r.version,
        ))
      )
        throw new DomainError('VERSION_CONFLICT', 'This register changed. Reload and try again.');
      await tx.audit.append({
        branchId: r.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'register.reopen',
        entityType: 'register',
        entityId: sessionId,
        // The close being undone is kept here, so no closing figures are ever lost.
        before: {
          closedAt: r.closedAt?.toISOString() ?? null,
          closedBy: r.closedByName,
          expectedCash: r.expectedCash,
          countedCash: r.countedCash,
          variance: r.variance,
        },
        reason: cmd.reason,
        correlationId: ctx.correlationId,
      });
      return view(tx, (await tx.registers.find(sessionId))!, await tx.customers.currency());
    });
  }
}
