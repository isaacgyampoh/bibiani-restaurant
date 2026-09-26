import { z } from 'zod';

const uuid = z.string().uuid();

/** One batch of floor records uploaded by an in-store hub. Applying a batch id twice changes nothing. */
export const HubBatchCommand = z.object({
  batchId: uuid,
  records: z
    .array(
      z.object({
        table: z.string().regex(/^[a-z_]{2,40}$/),
        row: z.record(z.string(), z.unknown()),
        /** The row no longer exists on the hub (only accepted for recomputed tax lines). */
        deleted: z.boolean().optional(),
      }),
    )
    .max(500),
});
export type HubBatchCommand = z.infer<typeof HubBatchCommand>;

const pin = z.string().regex(/^\d{4,6}$/);
export const HubPinVerifyCommand = z.object({ pin });
export type HubPinVerifyCommand = z.infer<typeof HubPinVerifyCommand>;

export const HubPinChangeCommand = z.object({ staffId: uuid, currentPin: pin.nullish(), newPin: pin });
export type HubPinChangeCommand = z.infer<typeof HubPinChangeCommand>;

export const SetBranchHubCommand = z.object({ hubDeviceId: uuid.nullable() });
export type SetBranchHubCommand = z.infer<typeof SetBranchHubCommand>;

export interface HubSnapshotView {
  generatedAt: string;
  restaurantId: string;
  branchId: string;
  hubDeviceId: string;
  /** True when this hub operates the branch (the cloud accepts its uploads). */
  attached: boolean;
  tables: Record<string, Record<string, unknown>[]>;
  /** Stock movements of the branch since the requested time (overlapping windows are fine: ids dedupe). */
  movements: Record<string, unknown>[];
  /** Cloud order-number counters; the hub keeps whichever is higher, so numbers never repeat. */
  orderCounters: Record<string, unknown>[];
}

export interface HubBatchResultView {
  batchId: string;
  records: number;
  applied: number;
  conflicts: { index: number; table: string; key: string; reason: string }[];
}
