import { PAYMENT_METHODS, STOCK_MOVEMENT_KINDS } from '@rp/domain';
import { z } from 'zod';

const uuid = z.uuid();
const minor = z.number().int().nonnegative().max(1_000_000_000);
const text = (max: number) => z.string().trim().max(max);
const day = z.iso.date();

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
export const CreateCustomerCommand = z.object({
  customerId: uuid,
  fullName: text(80).min(1, 'Enter the customer’s name'),
  phone: text(30).min(1, 'Enter the customer’s telephone number'),
  email: z.email('Enter a valid email address').max(120).nullish().or(z.literal('')),
  notes: text(500).nullish(),
});
export type CreateCustomerCommand = z.infer<typeof CreateCustomerCommand>;

export const UpdateCustomerCommand = CreateCustomerCommand.omit({ customerId: true }).extend({
  version: z.number().int().positive(),
});
export type UpdateCustomerCommand = z.infer<typeof UpdateCustomerCommand>;

/** Merges the customer in the path (the duplicate) into `intoCustomerId`. */
export const MergeCustomerCommand = z.object({ intoCustomerId: uuid, reason: text(200).min(3) });
export type MergeCustomerCommand = z.infer<typeof MergeCustomerCommand>;

/** Sets (or clears, with an empty phone) the customer of an open order, by telephone number. */
export const SetOrderCustomerCommand = z.object({
  customerName: text(80).nullish(),
  customerPhone: text(30).nullish(),
});
export type SetOrderCustomerCommand = z.infer<typeof SetOrderCustomerCommand>;

export interface CustomerSummaryView {
  id: string;
  fullName: string | null;
  /** Canonical, e.g. +233241234567 (use for tel: links). */
  phone: string;
  /** As people write it, e.g. 024 123 4567. */
  phoneDisplay: string;
  email: string | null;
  orders: number;
  totalSpend: number;
  firstVisit: string | null;
  lastVisit: string | null;
  createdAt: string;
}

export interface CustomerOrderView {
  id: string;
  orderNumber: number;
  businessDay: string;
  channel: 'dine_in' | 'takeaway';
  status: string;
  total: number;
  paid: number;
  methods: string[];
  items: string;
}

export interface CustomerDetailView extends CustomerSummaryView {
  notes: string | null;
  updatedAt: string;
  version: number;
  mergedIntoId: string | null;
  /** Records merged into this one. */
  mergedFrom: { id: string; phoneDisplay: string; fullName: string | null }[];
  recentOrders: CustomerOrderView[];
  currency: string;
}

export interface CustomerListView {
  customers: CustomerSummaryView[];
  total: number;
  currency: string;
}

/**
 * What a till sees when looking a customer up while taking an order: an exact telephone match
 * shows the number; a name search shows it masked (024 *** 4567).
 */
export interface CustomerLookupView {
  matches: { id: string; fullName: string | null; phoneDisplay: string; exact: boolean; orders: number }[];
}

// ---------------------------------------------------------------------------
// Cash registers
// ---------------------------------------------------------------------------
export const OpenRegisterCommand = z.object({
  sessionId: uuid,
  branchId: uuid,
  openingCash: minor,
  note: text(200).nullish(),
});
export type OpenRegisterCommand = z.infer<typeof OpenRegisterCommand>;

export const CloseRegisterCommand = z.object({
  countedCash: minor,
  note: text(300).nullish(),
  version: z.number().int().positive(),
});
export type CloseRegisterCommand = z.infer<typeof CloseRegisterCommand>;

export const ReopenRegisterCommand = z.object({ reason: text(200).min(3) });
export type ReopenRegisterCommand = z.infer<typeof ReopenRegisterCommand>;

export interface RegisterMethodTotal {
  method: 'cash' | 'momo' | 'card';
  charges: number;
  refunds: number;
  net: number;
  count: number;
}

export interface RegisterSessionView {
  id: string;
  branchId: string;
  status: 'open' | 'closed';
  terminalName: string;
  deviceId: string | null;
  cashierStaffId: string;
  cashierName: string;
  openedAt: string;
  openingCash: number;
  openingNote: string | null;
  /** Live while open; as recorded at close once closed. */
  cashSales: number;
  cashRefunds: number;
  expectedCash: number;
  byMethod: RegisterMethodTotal[];
  totalNet: number;
  payments: number;
  orders: { total: number; dineIn: number; takeaway: number };
  closedAt: string | null;
  closedByName: string | null;
  countedCash: number | null;
  variance: number | null;
  closingNote: string | null;
  reopenCount: number;
  reopenedAt: string | null;
  reopenReason: string | null;
  version: number;
  currency: string;
}

export interface RegisterListView {
  sessions: RegisterSessionView[];
  currency: string;
}

// ---------------------------------------------------------------------------
// Reports: every report is computed once into a ReportView; the screen and the PDF / Excel /
// CSV exports all render that same data.
// ---------------------------------------------------------------------------
export const REPORT_KINDS = [
  'end_of_day',
  'tax',
  'items',
  'payment_methods',
  'service_types',
  'terminals',
  'sales_by_staff',
  'staff_activity',
  'orders',
  'customers',
  'inventory_valuation',
  'stock_movements',
  'deliveries',
  'wastage',
  'adjustments',
  'stock_takes',
  'recipe_consumption',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const EXPORT_FORMATS = ['pdf', 'xlsx', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const ReportQuery = z.object({
  branchId: uuid,
  preset: z.enum(['today', 'yesterday', 'this_week', 'this_month', 'last_month', 'custom']).default('today'),
  from: day.nullish(),
  to: day.nullish(),
  staffId: uuid.nullish(),
  method: z.enum(PAYMENT_METHODS).nullish(),
  channel: z.enum(['dine_in', 'takeaway']).nullish(),
  deviceId: uuid.nullish(),
  tableId: uuid.nullish(),
  categoryId: uuid.nullish(),
  productId: uuid.nullish(),
  movementKind: z.enum(STOCK_MOVEMENT_KINDS).nullish(),
  orderStatus: z.enum(['completed', 'cancelled', 'open']).nullish(),
  sort: z.enum(['sales', 'quantity', 'name']).nullish(),
});
export type ReportQuery = z.infer<typeof ReportQuery>;

/** money: minor units; percent: basis points (1500 = 15.00 %); qty: a decimal quantity. */
export type ReportFormat = 'text' | 'money' | 'int' | 'qty' | 'percent' | 'date' | 'datetime';
export type ReportValue = string | number | null;

export interface ReportColumn {
  key: string;
  label: string;
  format: ReportFormat;
}

export interface ReportTable {
  id: string;
  title: string;
  columns: ReportColumn[];
  rows: Record<string, ReportValue>[];
  /** A totals row, when the columns add up. */
  totals: Record<string, ReportValue> | null;
  /** Shown when there are no rows. */
  empty: string;
}

export interface ReportMetric {
  label: string;
  value: ReportValue;
  format: ReportFormat;
  /** The headline figure of its group. */
  emphasis?: boolean;
}

export interface ReportView {
  kind: ReportKind | 'register_closing';
  title: string;
  restaurantName: string;
  branchName: string;
  currency: string;
  timezone: string;
  period: { from: string; to: string; label: string };
  generatedAt: string;
  /** Generated time in the restaurant's timezone, e.g. "28 Sep 2026, 22:14". */
  generatedAtLocal: string;
  generatedBy: string | null;
  filters: { label: string; value: string }[];
  summary: { title: string; metrics: ReportMetric[] }[];
  tables: ReportTable[];
  notes: string[];
  /** Signature lines printed at the end (register closing). */
  signOff: string[];
}

/** Everything the report filters can offer for one branch. */
export interface ReportFilterOptionsView {
  staff: { id: string; name: string; role: string | null }[];
  terminals: { id: string; name: string }[];
  tables: { id: string; label: string }[];
  categories: { id: string; name: string }[];
  products: { id: string; name: string; categoryId: string }[];
  timezone: string;
  today: string;
}
