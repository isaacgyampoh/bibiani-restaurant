import { INVENTORY_UNITS, PAYMENT_METHODS, TICKET_ACTIONS } from '@rp/domain';
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

// ---------------------------------------------------------------------------
// Inventory and stock taking
// ---------------------------------------------------------------------------
const quantity = z.number().finite().min(-1_000_000).max(1_000_000);
export const SaveInventoryItemCommand = z.object({
  id: uuid.optional(),
  branchId: uuid,
  name: text(80).min(1),
  sku: text(40).nullish(),
  category: text(40).nullish(),
  unit: z.enum(INVENTORY_UNITS),
  minQuantity: quantity.min(0).default(0),
  unitCost: minor.min(0).default(0),
  isActive: z.boolean().default(true),
});
export type SaveInventoryItemCommand = z.infer<typeof SaveInventoryItemCommand>;

export const RecordStockMovementCommand = z.object({
  movementId: uuid,
  itemId: uuid,
  kind: z.enum(['receive', 'waste', 'adjust']),
  quantity,
  unitCost: minor.min(0).nullish(),
  reason: text(200).nullish(),
  reference: text(80).nullish(),
});
export type RecordStockMovementCommand = z.infer<typeof RecordStockMovementCommand>;

export const StartStockCountCommand = z.object({
  countId: uuid,
  branchId: uuid,
  note: text(200).nullish(),
  /** Items to count; all active items when omitted. */
  itemIds: z.array(uuid).max(1000).nullish(),
});
export type StartStockCountCommand = z.infer<typeof StartStockCountCommand>;

export const RecordCountLineCommand = z.object({
  itemId: uuid,
  countedQuantity: quantity.min(0).nullable(),
  reason: text(200).nullish(),
});
export type RecordCountLineCommand = z.infer<typeof RecordCountLineCommand>;

export const StockCountDecisionCommand = z.object({ expectedVersion: z.number().int().positive() });
export type StockCountDecisionCommand = z.infer<typeof StockCountDecisionCommand>;

// ---------------------------------------------------------------------------
// Floor operations and staff PINs
// ---------------------------------------------------------------------------
export const TransferOrderCommand = z.object({
  areaId: uuid,
  tableId: uuid.nullish(),
  customerName: text(80).nullish(),
});
export type TransferOrderCommand = z.infer<typeof TransferOrderCommand>;
export const MergeOrderCommand = z.object({ sourceOrderId: uuid });
export type MergeOrderCommand = z.infer<typeof MergeOrderCommand>;
export const OrderPriorityCommand = z.object({ rush: z.boolean() });
export type OrderPriorityCommand = z.infer<typeof OrderPriorityCommand>;

const pin = z.string().regex(/^\d{4,6}$/, 'A PIN is 4 to 6 digits');
export const PinSignInCommand = z.object({ pin: z.string().max(12) });
export type PinSignInCommand = z.infer<typeof PinSignInCommand>;
export const ChangePinCommand = z.object({ currentPin: z.string().max(12).nullish(), newPin: pin });
export type ChangePinCommand = z.infer<typeof ChangePinCommand>;
export const AssignPinCommand = z.object({ pin });
export type AssignPinCommand = z.infer<typeof AssignPinCommand>;
export const PinRecoveryCommand = z.object({ email: z.email().max(200) });
export type PinRecoveryCommand = z.infer<typeof PinRecoveryCommand>;

export const SaveRecipeCommand = z.object({
  components: z.array(z.object({ itemId: uuid, quantity: quantity.positive() })).max(30),
});
export type SaveRecipeCommand = z.infer<typeof SaveRecipeCommand>;

// Pricing: promotions (automatic) and manager discounts (manual).
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const day = z.iso.date();
export const SavePromotionCommand = z.object({
  id: uuid.nullish(),
  expectedVersion: z.number().int().positive().nullish(),
  name: text(60).min(1),
  kind: z.enum(['percent_off', 'amount_off', 'fixed_price', 'bundle_price', 'buy_get_free']),
  percentBp: z.number().int().min(1).max(10_000).nullish(),
  amount: minor.nullish(),
  /** Bundle size (bundle_price) or how many are bought (buy_get_free). */
  bundleQuantity: z.number().int().min(1).max(99).nullish(),
  /** buy_get_free: how many come free. */
  freeQuantity: z.number().int().min(1).max(20).nullish(),
  appliesToAll: z.boolean().default(false),
  productIds: z.array(uuid).max(500).default([]),
  categoryIds: z.array(uuid).max(200).default([]),
  branchId: uuid.nullish(),
  startsOn: day.nullish(),
  endsOn: day.nullish(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).nullish(),
  startTime: hhmm.nullish(),
  endTime: hhmm.nullish(),
  priority: z.number().int().min(0).max(100).default(0),
  status: z.enum(['active', 'paused']).default('active'),
});
export type SavePromotionCommand = z.infer<typeof SavePromotionCommand>;

export const SetPromotionStatusCommand = z.object({
  action: z.enum(['activate', 'pause', 'end']),
  expectedVersion: z.number().int().positive(),
});
export type SetPromotionStatusCommand = z.infer<typeof SetPromotionStatusCommand>;

export const ManualDiscountCommand = z.object({
  discountId: uuid,
  kind: z.enum(['amount', 'percent']),
  /** Minor units, or basis points for a percentage (1000 = 10%). */
  value: z.number().int().positive().max(1_000_000_000),
  reason: text(200).min(3),
});
export type ManualDiscountCommand = z.infer<typeof ManualDiscountCommand>;

// Owner onboarding (public start; accept with the emailed-link session).
export const OnboardingStartCommand = z.object({ email: z.string().trim().max(200) });
export type OnboardingStartCommand = z.infer<typeof OnboardingStartCommand>;
export const OnboardingAcceptCommand = z.object({ fullName: text(80).min(2) });
export type OnboardingAcceptCommand = z.infer<typeof OnboardingAcceptCommand>;

// Device-initiated pairing.
export const CollectPairingCommand = z.object({ secret: z.string().min(20).max(100) });
export type CollectPairingCommand = z.infer<typeof CollectPairingCommand>;
export const ApprovePairingCommand = z.object({ code: z.string().trim().min(8).max(12) });
export type ApprovePairingCommand = z.infer<typeof ApprovePairingCommand>;
