// Single authoritative definition of every status/enum value in the platform.
// The database enums must match these exactly (enforced by an automated test).

export const ORDER_CHANNELS = ['dine_in', 'takeaway'] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

export const ORDER_STATUSES = [
  'draft',
  'submitted',
  'in_preparation',
  'partially_ready',
  'ready',
  'served',
  'picked_up',
  'completed',
  'cancelled',
  'voided',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = [
  'unpaid',
  'partially_paid',
  'paid',
  'partially_refunded',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const ORDER_ITEM_STATUSES = [
  'pending',
  'sent',
  'accepted',
  'in_preparation',
  'ready',
  'served',
  'cancelled',
  'voided',
] as const;
export type OrderItemStatus = (typeof ORDER_ITEM_STATUSES)[number];

export const TICKET_STATUSES = [
  'new',
  'accepted',
  'in_preparation',
  'on_hold',
  'ready',
  'completed',
  'cancelled',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const PRINT_JOB_KINDS = ['kitchen_ticket', 'receipt', 'void_slip', 'test'] as const;
export type PrintJobKind = (typeof PRINT_JOB_KINDS)[number];

export const PRINT_JOB_STATUSES = ['pending', 'claimed', 'printed', 'failed', 'dead', 'cancelled'] as const;
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];

export const PRINTER_CONNECTIONS = ['network_escpos', 'usb_escpos'] as const;
export type PrinterConnection = (typeof PRINTER_CONNECTIONS)[number];

/** V1 payments are manual records. "Split" is several records on one order, not a method. */
export const PAYMENT_METHODS = ['cash', 'momo', 'card'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * When money must be settled relative to handing the order over. Configuration
 * per operational area, never a rule baked into use cases. ('allow_credit' is
 * reserved for a later phase with a credit-accounting module.)
 */
export const PAYMENT_POLICIES = ['pay_before_fulfillment', 'pay_after_fulfillment'] as const;
export type PaymentPolicy = (typeof PAYMENT_POLICIES)[number];

export const PAYMENT_DIRECTIONS = ['charge', 'refund'] as const;
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

export const PAYMENT_RECORD_STATUSES = ['recorded', 'voided'] as const;
export type PaymentRecordStatus = (typeof PAYMENT_RECORD_STATUSES)[number];

export const DEVICE_KINDS = ['pos', 'kds', 'printer', 'print_agent', 'customer_display'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const DEVICE_STATUSES = ['unknown', 'online', 'offline'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const STATION_OUTPUT_ROLES = ['primary', 'copy', 'backup'] as const;
export type StationOutputRole = (typeof STATION_OUTPUT_ROLES)[number];

export const ROUTING_MATCHES = ['product', 'category', 'default'] as const;
export type RoutingMatch = (typeof ROUTING_MATCHES)[number];

export const TABLE_STATUSES = [
  'available',
  'occupied',
  'reserved',
  'cleaning',
  'payment_pending',
  'out_of_service',
] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];

export const PERMISSIONS = [
  'order.create',
  'order.send',
  'order.fulfil',
  'order.cancel',
  'order.void',
  'order.view',
  'kitchen.operate',
  'payment.record',
  'payment.void',
  'payment.refund',
  'print.manage',
  'receipt.print',
  'print.agent',
  'display.view',
  'device.manage',
  'menu.manage',
  'config.manage',
  'staff.manage',
  'audit.view',
  'reports.view',
  'inventory.manage',
  'stock.count',
  'promotions.manage',
  'discount.apply',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Deliberately narrow permission sets for paired devices. POS devices act only through a signed-in staff member. */
export const DEVICE_PERMISSIONS: Record<DeviceKind, readonly Permission[]> = {
  pos: [],
  kds: ['kitchen.operate', 'order.view'],
  printer: [],
  print_agent: ['print.agent'],
  customer_display: ['display.view'],
};

export const STOCK_MOVEMENT_KINDS = ['receive', 'waste', 'adjust', 'count', 'sale', 'sale_reversal'] as const;
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];

export const STOCK_COUNT_STATUSES = ['open', 'submitted', 'approved', 'cancelled'] as const;
export type StockCountStatus = (typeof STOCK_COUNT_STATUSES)[number];

export const INVENTORY_UNITS = [
  'kg',
  'g',
  'l',
  'ml',
  'pcs',
  'pack',
  'bottle',
  'crate',
  'bag',
  'tray',
] as const;
export type InventoryUnit = (typeof INVENTORY_UNITS)[number];
