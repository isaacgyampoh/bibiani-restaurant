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

/** Request the customer's bill: printed on `printerId` or this till's receipt printer, if any. */
export const RequestBillCommand = z.object({ requestId: uuid, printerId: uuid.nullish() });
export type RequestBillCommand = z.infer<typeof RequestBillCommand>;

export const TestPrintCommand = z.object({ requestId: uuid });
export type TestPrintCommand = z.infer<typeof TestPrintCommand>;

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
  /** Back-office password (managers/owners). Staff who only use tills sign in with their PIN. */
  password: z.string().min(10).max(128).nullish(),
  /** First PIN, assigned by the owner; the staff member replaces it on first sign-in. */
  pin: z
    .string()
    .regex(/^\d{4,6}$/)
    .nullish(),
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
  restaurant: z.object({
    id,
    name: text(80).min(1),
    phone: text(40).nullish(),
    receiptFooter: text(200).nullish(),
  }),
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
    printOrderNumber: z.boolean().default(true),
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
    description: text(300).nullish(),
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
    /** Show authoritative line prices on this station's screen and tickets. */
    showPrices: z.boolean().optional(),
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
        /** network_escpos: IP[:port] on the restaurant network. usb_escpos: the Windows printer name on
         *  the PC running MY FOOD Printing (a USB printer plugged into that PC). */
        connection: z.enum(['network_escpos', 'usb_escpos']).default('network_escpos'),
        address: z.string().trim().min(1, 'Enter the printer address').max(80),
        agentDeviceId: uuid.nullish(),
        paperWidthMm: z.union([z.literal(58), z.literal(80)]).default(80),
        backupPrinterId: uuid.nullish(),
      })
      .superRefine((p, ctx) => {
        if (p.connection === 'network_escpos' && !/^[A-Za-z0-9.-]+(:\d{2,5})?$/.test(p.address))
          ctx.addIssue({
            code: 'custom',
            path: ['address'],
            message: 'Enter the printer IP address, e.g. 192.168.1.50 (port 9100 is assumed)',
          });
        // Printable characters only, and no quote or backslash.
        if (
          p.connection === 'usb_escpos' &&
          (/["\\]/.test(p.address) || [...p.address].some((c) => c.charCodeAt(0) < 32))
        )
          ctx.addIssue({
            code: 'custom',
            path: ['address'],
            message: 'Enter the Windows printer name exactly as shown',
          });
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
