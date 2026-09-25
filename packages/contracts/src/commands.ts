import { PAYMENT_METHODS, TICKET_ACTIONS } from '@rp/domain';
import { z } from 'zod';

// Request bodies accepted by the API. One definition, used by the API for
// validation and by clients (POS, KDS, print agent) for typing.

const uuid = z.uuid();
const minor = z.number().int().nonnegative().max(1_000_000_000);
const text = (max: number) => z.string().trim().max(max);

export const OrderItemInput = z.object({
  id: uuid,
  productId: uuid,
  quantity: z.number().int().min(1).max(999),
  modifierIds: z.array(uuid).max(30).default([]),
  notes: text(200).nullish(),
});

export const SubmitOrderCommand = z.object({
  orderId: uuid,
  branchId: uuid,
  areaId: uuid,
  tableId: uuid.nullish(),
  customerName: text(80).nullish(),
  customerPhone: text(30).nullish(),
  notes: text(300).nullish(),
  clientCreatedAt: z.iso.datetime({ offset: true }).nullish(),
  items: z.array(OrderItemInput).max(200).default([]),
  /** Present = send every pending item to production in the same transaction. */
  send: z.object({ submissionId: uuid }).nullish(),
});
export type SubmitOrderCommand = z.infer<typeof SubmitOrderCommand>;

export const SendToKitchenCommand = z.object({ submissionId: uuid });
export type SendToKitchenCommand = z.infer<typeof SendToKitchenCommand>;

export const TicketActionCommand = z.object({
  action: z.enum(TICKET_ACTIONS),
  expectedVersion: z.number().int().positive().nullish(),
});
export type TicketActionCommand = z.infer<typeof TicketActionCommand>;

export const FulfilOrderCommand = z.object({ itemIds: z.array(uuid).max(200).nullish() });
export type FulfilOrderCommand = z.infer<typeof FulfilOrderCommand>;

export const RecordPaymentCommand = z.object({
  paymentId: uuid,
  method: z.enum(PAYMENT_METHODS),
  amount: minor.positive().nullish(),
  tendered: minor.positive().nullish(),
  reference: text(80).nullish(),
  note: text(200).nullish(),
});
export type RecordPaymentCommand = z.infer<typeof RecordPaymentCommand>;

export const VoidPaymentCommand = z.object({ reason: text(200).min(3) });
export type VoidPaymentCommand = z.infer<typeof VoidPaymentCommand>;

export const RefundPaymentCommand = z.object({
  refundId: uuid,
  amount: minor.positive(),
  reason: text(200).min(3),
});
export type RefundPaymentCommand = z.infer<typeof RefundPaymentCommand>;

export const ClaimPrintJobsCommand = z.object({ limit: z.number().int().min(1).max(20).default(5) });
export type ClaimPrintJobsCommand = z.infer<typeof ClaimPrintJobsCommand>;

export const PrintJobResultCommand = z.object({
  claimId: uuid,
  outcome: z.enum(['printed', 'failed_before_send', 'failed_after_send']),
  error: text(500).nullish(),
});
export type PrintJobResultCommand = z.infer<typeof PrintJobResultCommand>;

export const HeartbeatCommand = z.object({
  appVersion: text(40).nullish(),
  printers: z
    .array(z.object({ printerId: uuid, ok: z.boolean(), error: text(300).nullish() }))
    .max(50)
    .default([]),
});
export type HeartbeatCommand = z.infer<typeof HeartbeatCommand>;
