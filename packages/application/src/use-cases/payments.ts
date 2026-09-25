import type {
  OrderView,
  RecordPaymentCommand,
  RefundPaymentCommand,
  VoidPaymentCommand,
} from '@rp/contracts';
import { balanceDue, DomainError, planPayment, planRefund, summarizePayments } from '@rp/domain';
import type { OrderAggregate, Repositories } from '../ports';
import { authorize, type RequestContext } from '../principal';
import { CommitLog, type Dependencies, settleOrderState } from './shared';

/**
 * V1: manual payment recording only (cash, MoMo, card). The cashier has
 * already verified the money. Split payments are several calls. Retrying with
 * the same paymentId never records a second payment.
 */
export class RecordPayment {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, orderId: string, cmd: RecordPaymentCommand): Promise<OrderView> {
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const hash = this.deps.fingerprint.of({ op: 'record_payment', orderId, cmd });
    const view = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const agg = await lockOrder(tx, orderId);
      authorize(ctx.principal, 'payment.record', agg.header.branchId);

      const existing =
        agg.payments.find((p) => p.id === cmd.paymentId) ?? (await tx.payments.find(cmd.paymentId));
      if (existing) {
        if (existing.orderId !== orderId || existing.requestHash !== hash) {
          throw new DomainError(
            'IDEMPOTENCY_MISMATCH',
            'This payment id was already used for a different payment',
            {
              paymentId: cmd.paymentId,
            },
          );
        }
        log.add('payment.replayed', { orderId, paymentId: cmd.paymentId });
        return (await tx.read.order(orderId))!;
      }
      if (agg.header.status === 'cancelled' || agg.header.status === 'voided') {
        throw new DomainError('ORDER_CLOSED', 'This order is closed');
      }

      const balance = balanceDue(agg.header.grandTotal, summarizePayments(agg.payments));
      const planned = planPayment(balance, {
        method: cmd.method,
        amount: cmd.amount,
        tendered: cmd.tendered,
      });
      const record = {
        id: cmd.paymentId,
        branchId: agg.header.branchId,
        orderId,
        direction: 'charge' as const,
        refundOfPaymentId: null,
        method: cmd.method,
        amount: planned.amount,
        tenderedAmount: planned.tendered,
        changeAmount: planned.change,
        reference: cmd.reference ?? null,
        note: cmd.note ?? null,
        requestHash: hash,
        recordedByStaffId: ctx.principal.staffId,
        deviceId: ctx.deviceId,
      };
      await tx.payments.insert(record);
      agg.payments.push({ ...record, status: 'recorded' });
      await tx.audit.append({
        branchId: agg.header.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'payment.record',
        entityType: 'payment',
        entityId: record.id,
        after: {
          orderId,
          method: record.method,
          amount: record.amount,
          tendered: record.tenderedAmount,
          change: record.changeAmount,
        },
        correlationId: ctx.correlationId,
      });
      log.add('payment.recorded', {
        orderId,
        orderNumber: agg.header.orderNumber,
        paymentId: record.id,
        method: record.method,
        amount: record.amount,
        balanceBefore: balance,
      });
      await settleOrderState(tx, agg, ctx, now, log);
      return (await tx.read.order(orderId))!;
    });
    log.flush(this.deps.logger);
    return view;
  }
}

/** Voids a mistaken payment record. Never edits it; keeps it with reason and actor. */
export class VoidPayment {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, paymentId: string, cmd: VoidPaymentCommand): Promise<OrderView> {
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const view = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const peek = await tx.payments.find(paymentId);
      if (!peek) throw new DomainError('NOT_FOUND', 'Payment not found', { paymentId });
      const agg = await lockOrder(tx, peek.orderId);
      authorize(ctx.principal, 'payment.void', agg.header.branchId);
      const payment = agg.payments.find((p) => p.id === paymentId)!;
      if (payment.status === 'voided') return (await tx.read.order(agg.header.id))!; // idempotent
      const liveRefunds = agg.payments.filter(
        (p) => p.refundOfPaymentId === paymentId && p.status === 'recorded',
      );
      if (liveRefunds.length > 0) {
        throw new DomainError('INVALID_TRANSITION', 'Void the refunds on this payment first', { paymentId });
      }
      await tx.payments.markVoided(paymentId, ctx.principal.staffId, cmd.reason, now);
      payment.status = 'voided';
      await tx.audit.append({
        branchId: agg.header.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'payment.void',
        entityType: 'payment',
        entityId: paymentId,
        before: { status: 'recorded', method: payment.method, amount: payment.amount },
        after: { status: 'voided' },
        reason: cmd.reason,
        correlationId: ctx.correlationId,
      });
      log.add('payment.voided', { orderId: agg.header.id, paymentId, reason: cmd.reason });
      await settleOrderState(tx, agg, ctx, now, log);
      return (await tx.read.order(agg.header.id))!;
    });
    log.flush(this.deps.logger);
    return view;
  }
}

/** Records money given back to the customer against an earlier payment. */
export class RefundPayment {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, paymentId: string, cmd: RefundPaymentCommand): Promise<OrderView> {
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const hash = this.deps.fingerprint.of({ op: 'refund_payment', paymentId, cmd });
    const view = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const peek = await tx.payments.find(paymentId);
      if (!peek) throw new DomainError('NOT_FOUND', 'Payment not found', { paymentId });
      const agg = await lockOrder(tx, peek.orderId);
      authorize(ctx.principal, 'payment.refund', agg.header.branchId);

      const existing =
        agg.payments.find((p) => p.id === cmd.refundId) ?? (await tx.payments.find(cmd.refundId));
      if (existing) {
        if (existing.requestHash !== hash) {
          throw new DomainError('IDEMPOTENCY_MISMATCH', 'This refund id was already used', {
            refundId: cmd.refundId,
          });
        }
        return (await tx.read.order(agg.header.id))!;
      }
      const original = agg.payments.find((p) => p.id === paymentId)!;
      const already = agg.payments
        .filter((p) => p.refundOfPaymentId === paymentId && p.status === 'recorded')
        .reduce((acc, p) => acc + p.amount, 0);
      const amount = planRefund(original, already, cmd.amount);
      const record = {
        id: cmd.refundId,
        branchId: agg.header.branchId,
        orderId: agg.header.id,
        direction: 'refund' as const,
        refundOfPaymentId: paymentId,
        method: original.method,
        amount,
        tenderedAmount: null,
        changeAmount: 0,
        reference: null,
        note: cmd.reason,
        requestHash: hash,
        recordedByStaffId: ctx.principal.staffId,
        deviceId: ctx.deviceId,
      };
      await tx.payments.insert(record);
      agg.payments.push({ ...record, status: 'recorded' });
      await tx.audit.append({
        branchId: agg.header.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'payment.refund',
        entityType: 'payment',
        entityId: record.id,
        after: { refundOf: paymentId, method: record.method, amount },
        reason: cmd.reason,
        correlationId: ctx.correlationId,
      });
      log.add('payment.refunded', { orderId: agg.header.id, paymentId, refundId: record.id, amount });
      await settleOrderState(tx, agg, ctx, now, log);
      return (await tx.read.order(agg.header.id))!;
    });
    log.flush(this.deps.logger);
    return view;
  }
}

async function lockOrder(tx: Repositories, orderId: string): Promise<OrderAggregate> {
  const agg = await tx.orders.findForUpdate(orderId);
  if (!agg) throw new DomainError('NOT_FOUND', 'Order not found', { orderId });
  return agg;
}
