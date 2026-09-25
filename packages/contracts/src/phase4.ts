import {
  DEVICE_KINDS,
  PAYMENT_POLICIES,
  PERMISSIONS,
  ROUTING_MATCHES,
  STATION_OUTPUT_ROLES,
} from '@rp/domain';
import { z } from 'zod';

const uuid = z.uuid();
const text = (max: number) => z.string().trim().max(max);
const reason = text(200).min(3);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------
export const CancelOrderCommand = z.object({ reason });
export type CancelOrderCommand = z.infer<typeof CancelOrderCommand>;

export const VoidItemsCommand = z.object({ requestId: uuid, itemIds: z.array(uuid).min(1).max(100), reason });
export type VoidItemsCommand = z.infer<typeof VoidItemsCommand>;

export const PrintReceiptCommand = z.object({ requestId: uuid, printerId: uuid.nullish() });
export type PrintReceiptCommand = z.infer<typeof PrintReceiptCommand>;

export const SetTableStatusCommand = z.object({
  status: z.enum(['available', 'reserved', 'out_of_service']),
});
export type SetTableStatusCommand = z.infer<typeof SetTableStatusCommand>;

// ---------------------------------------------------------------------------
// Devices & pairing
// ---------------------------------------------------------------------------
export const PairDeviceCommand = z.object({ code: z.string().trim().min(6).max(16) });
export type PairDeviceCommand = z.infer<typeof PairDeviceCommand>;

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------
export const CreateStaffCommand = z.object({
  displayName: text(80).min(1),
  email: z.email().max(200),
  password: z.string().min(10).max(128),
  roleIds: z.array(uuid).min(1).max(10),
  branchId: uuid.nullish(),
});
export type CreateStaffCommand = z.infer<typeof CreateStaffCommand>;

export const UpdateStaffCommand = z.object({
  displayName: text(80).min(1).optional(),
  isActive: z.boolean().optional(),
  roleIds: z.array(uuid).min(1).max(10).optional(),
  branchId: uuid.nullish(),
  password: z.string().min(10).max(128).optional(),
});
export type UpdateStaffCommand = z.infer<typeof UpdateStaffCommand>;

// ---------------------------------------------------------------------------
// Configuration entities (admin). One schema per entity; ids optional on create.
// ---------------------------------------------------------------------------
const id = uuid.optional();
export const ConfigSchemas = {
  branch: z.object({
    id,
    name: text(80).min(1),
    code: z
      .string()
      .regex(/^[A-Z0-9-]{1,12}$/)
      .optional(),
    address: text(200).nullish(),
    timezone: text(64).optional(),
    businessDayCutoff: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    orderNumberStart: z.number().int().positive().optional(),
    isActive: z.boolean().optional(),
  }),
  area: z.object({
    id,
    branchId: uuid,
    name: text(60).min(1),
    channel: z.enum(['dine_in', 'takeaway']),
    requiresTable: z.boolean().default(false),
    requiresCustomerName: z.boolean().default(false),
    paymentPolicy: z.enum(PAYMENT_POLICIES).default('pay_after_fulfillment'),
    requirePaymentBeforeProduction: z.boolean().default(false),
    showOnCustomerDisplay: z.boolean().default(true),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().default(0),
  }),
  table: z.object({
    id,
    branchId: uuid,
    areaId: uuid,
    label: text(12).min(1),
    capacity: z.number().int().min(1).max(50).default(4),
    isActive: z.boolean().default(true),
  }),
  category: z.object({
    id,
    name: text(60).min(1),
    parentId: uuid.nullish(),
    sortOrder: z.number().int().default(0),
    isActive: z.boolean().default(true),
  }),
  taxRate: z.object({
    id,
    name: text(60).min(1),
    rateBp: z.number().int().min(0).max(10000),
    isInclusive: z.boolean().default(true),
    isCompound: z.boolean().default(false),
    applyOrder: z.number().int().default(0),
    isActive: z.boolean().default(true),
  }),
  product: z.object({
    id,
    categoryId: uuid,
    name: text(80).min(1),
    kitchenName: text(40).nullish(),
    basePrice: z.number().int().min(0).max(100_000_000),
    requiresPreparation: z.boolean().default(true),
    isActive: z.boolean().default(true),
    taxRateIds: z.array(uuid).max(5).default([]),
    /** Replaces the product's modifier groups when given; left unchanged when omitted. */
    modifierGroupIds: z.array(uuid).max(10).optional(),
  }),
  modifierGroup: z.object({
    id,
    name: text(60).min(1),
    minSelect: z.number().int().min(0).max(10).default(0),
    maxSelect: z.number().int().min(1).max(20).nullish(),
  }),
  modifier: z.object({
    id,
    groupId: uuid,
    name: text(60).min(1),
    priceDelta: z.number().int().min(-10_000_000).max(10_000_000).default(0),
    sortOrder: z.number().int().default(0),
    isActive: z.boolean().default(true),
  }),
  branchProduct: z.object({
    branchId: uuid,
    productId: uuid,
    priceOverride: z.number().int().min(0).nullish(),
    isAvailable: z.boolean(),
  }),
  station: z.object({
    id,
    branchId: uuid,
    name: text(60).min(1),
    code: z.string().regex(/^[A-Z0-9-]{1,12}$/),
    targetPrepSeconds: z.number().int().positive().nullish(),
    autoReady: z.boolean().default(false),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().default(0),
  }),
  device: z.object({
    id,
    branchId: uuid,
    kind: z.enum(DEVICE_KINDS),
    name: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9 _-]{2,40}$/),
    stationId: uuid.nullish(),
    receiptPrinterId: uuid.nullish(),
    isActive: z.boolean().default(true),
    printer: z
      .object({
        address: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9.-]+(:\d{2,5})?$/),
        agentDeviceId: uuid.nullish(),
        paperWidthMm: z.union([z.literal(58), z.literal(80)]).default(80),
        backupPrinterId: uuid.nullish(),
      })
      .nullish(),
  }),
  stationOutput: z.object({
    id,
    stationId: uuid,
    deviceId: uuid,
    role: z.enum(STATION_OUTPUT_ROLES).default('primary'),
    copies: z.number().int().min(1).max(5).default(1),
  }),
  routingRule: z.object({
    id,
    branchId: uuid,
    match: z.enum(ROUTING_MATCHES),
    productId: uuid.nullish(),
    categoryId: uuid.nullish(),
    areaId: uuid.nullish(),
    stationId: uuid,
    priority: z.number().int().min(-100).max(100).default(0),
    isActive: z.boolean().default(true),
    extraPrinterIds: z.array(uuid).max(5).default([]),
  }),
  role: z.object({
    id,
    name: text(40).min(1),
    permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
  }),
} as const;
export type ConfigEntity = keyof typeof ConfigSchemas;
export const CONFIG_ENTITIES = Object.keys(ConfigSchemas) as ConfigEntity[];
export type ConfigRecord<E extends ConfigEntity> = z.infer<(typeof ConfigSchemas)[E]>;
/** Entities that can be deleted outright (join-like config). Everything else is deactivated instead. */
export const DELETABLE_CONFIG: readonly ConfigEntity[] = ['stationOutput', 'routingRule'];
