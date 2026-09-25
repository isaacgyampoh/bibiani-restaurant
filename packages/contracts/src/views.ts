import type {
  DocumentBlock,
  OrderChannel,
  OrderItemStatus,
  OrderStatus,
  PaymentDirection,
  PaymentMethod,
  PaymentRecordStatus,
  PaymentStatus,
  PrinterConnection,
  PrintJobKind,
  PrintJobStatus,
  TicketStatus,
} from '@rp/domain';

// Response shapes. Timestamps are ISO-8601 strings; money is integer minor units.

export interface OrderItemView {
  id: string;
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  modifiers: { modifierId: string; name: string; priceDelta: number }[];
  lineTotal: number;
  taxTotal: number;
  notes: string | null;
  status: OrderItemStatus;
  stationId: string | null;
  ticketId: string | null;
}

export interface TicketView {
  id: string;
  stationId: string;
  stationName: string;
  submissionId: string;
  status: TicketStatus;
  version: number;
  itemIds: string[];
  createdAt: string;
  readyAt: string | null;
  printJobs: { id: string; printerId: string; status: PrintJobStatus; possibleDuplicate: boolean }[];
}

export interface PaymentView {
  id: string;
  direction: PaymentDirection;
  refundOfPaymentId: string | null;
  method: PaymentMethod;
  amount: number;
  tenderedAmount: number | null;
  changeAmount: number;
  reference: string | null;
  status: PaymentRecordStatus;
  createdAt: string;
}

export interface OrderView {
  id: string;
  branchId: string;
  areaId: string;
  areaName: string;
  channel: OrderChannel;
  orderNumber: number;
  businessDay: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  table: { id: string; label: string } | null;
  customerName: string | null;
  customerPhone: string | null;
  notes: string | null;
  currency: string;
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
  paidTotal: number;
  refundedTotal: number;
  balanceDue: number;
  version: number;
  createdAt: string;
  firstSubmittedAt: string | null;
  readyAt: string | null;
  fulfilledAt: string | null;
  completedAt: string | null;
  /** Receipts queued so far; the next print is a REPRINT when this is above zero. */
  receiptsPrinted: number;
  items: OrderItemView[];
  tickets: TicketView[];
  payments: PaymentView[];
}

export interface OrderSummaryView {
  id: string;
  orderNumber: number;
  channel: OrderChannel;
  areaId: string;
  tableId: string | null;
  areaName: string;
  tableLabel: string | null;
  customerName: string | null;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  grandTotal: number;
  balanceDue: number;
  version: number;
  createdAt: string;
}

export interface StationTicketView {
  id: string;
  orderId: string;
  orderNumber: number;
  channel: OrderChannel;
  areaName: string;
  tableLabel: string | null;
  customerName: string | null;
  orderNotes: string | null;
  status: TicketStatus;
  version: number;
  createdAt: string;
  startedAt: string | null;
  readyAt: string | null;
  items: {
    id: string;
    quantity: number;
    name: string;
    modifiers: string[];
    notes: string | null;
    status: OrderItemStatus;
  }[];
}

export interface StationBoardView {
  station: { id: string; name: string; branchId: string; targetPrepSeconds: number | null };
  tickets: StationTicketView[];
  /** Print problems for this station's printers, so cooks know when paper is not coming. */
  printerAlerts: {
    printerId: string;
    printerName: string;
    failedJobs: number;
    deadJobs: number;
    lastError: string | null;
  }[];
  generatedAt: string;
}

/** Customer-facing board: order numbers and state only. No names, phones or totals. */
export interface CustomerBoardView {
  preparing: { orderNumber: number; channel: OrderChannel }[];
  ready: { orderNumber: number; channel: OrderChannel }[];
  generatedAt: string;
}

export interface PrintQueueView {
  jobs: {
    id: string;
    printerId: string;
    printerName: string;
    kind: PrintJobKind;
    status: PrintJobStatus;
    attempts: number;
    possibleDuplicate: boolean;
    lastError: string | null;
    orderId: string | null;
    orderNumber: number | null;
    createdAt: string;
  }[];
}

export interface ClaimedPrintJobView {
  id: string;
  printerId: string;
  claimId: string;
  kind: PrintJobKind;
  document: { schema: 1; title: string; blocks: DocumentBlock[] };
  possibleDuplicate: boolean;
  isReprint: boolean;
  attempts: number;
  orderId: string | null;
  productionTicketId: string | null;
  leaseExpiresAt: string;
}

export interface AgentConfigView {
  agentDeviceId: string;
  branchId: string;
  printers: {
    printerId: string;
    name: string;
    connection: PrinterConnection;
    address: string | null;
    paperWidthMm: number;
    isActive: boolean;
  }[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    /** Safe to show to restaurant staff. */
    message: string;
    correlationId: string;
    retryable: boolean;
  };
}

// ---------------------------------------------------------------------------
// Phase 4 views
// ---------------------------------------------------------------------------
export interface MeView {
  kind: 'staff' | 'device';
  displayName: string;
  restaurant: { id: string; name: string; currency: string };
  branches: { id: string; name: string }[];
  /** Permissions per branch (null key = all branches). The UI uses this only to hide what the server would refuse. */
  permissions: Record<string, string[]>;
  device: { id: string; kind: string; name: string; branchId: string; stationId: string | null } | null;
}

export interface MenuView {
  branchId: string;
  currency: string;
  areas: {
    id: string;
    name: string;
    channel: 'dine_in' | 'takeaway';
    requiresTable: boolean;
    requiresCustomerName: boolean;
    paymentPolicy: 'pay_before_fulfillment' | 'pay_after_fulfillment';
    requirePaymentBeforeProduction: boolean;
  }[];
  categories: { id: string; name: string; parentId: string | null; sortOrder: number }[];
  products: {
    id: string;
    categoryId: string;
    name: string;
    price: number;
    isAvailable: boolean;
    modifierGroups: {
      id: string;
      name: string;
      minSelect: number;
      maxSelect: number | null;
      modifiers: { id: string; name: string; priceDelta: number }[];
    }[];
  }[];
  version: string;
}

export type TableState =
  | 'available'
  | 'occupied'
  | 'ready_to_serve'
  | 'awaiting_payment'
  | 'cleaning'
  | 'reserved'
  | 'out_of_service';

export interface FloorView {
  branchId: string;
  areas: { id: string; name: string }[];
  tables: {
    id: string;
    areaId: string;
    label: string;
    capacity: number;
    state: TableState;
    order: {
      id: string;
      orderNumber: number;
      status: string;
      paymentStatus: string;
      grandTotal: number;
      balanceDue: number;
      openedAt: string;
    } | null;
  }[];
  generatedAt: string;
}

export interface OperationsView {
  branchId: string;
  devices: {
    id: string;
    name: string;
    kind: string;
    stationId: string | null;
    isActive: boolean;
    paired: boolean;
    status: 'online' | 'offline' | 'never_seen';
    lastSeenAt: string | null;
    appVersion: string | null;
    printer: {
      address: string | null;
      agentDeviceId: string | null;
      healthy: boolean | null;
      lastError: string | null;
      lastStatusAt: string | null;
      failedJobs: number;
      deadJobs: number;
    } | null;
  }[];
  generatedAt: string;
}

export interface ReceiptView {
  orderId: string;
  orderNumber: number;
  document: { schema: 1; title: string; blocks: import('@rp/domain').DocumentBlock[] };
}

export interface PairingCodeView {
  deviceId: string;
  code: string;
  expiresAt: string;
}

export interface PairDeviceResult {
  device: {
    id: string;
    name: string;
    kind: string;
    branchId: string;
    stationId: string | null;
    restaurantId: string;
  };
  session: { accessToken: string; refreshToken: string; expiresAt: number };
}

export interface ConfigurationView {
  restaurant: { id: string; name: string; currency: string; timezone: string };
  branches: Record<string, unknown>[];
  areas: Record<string, unknown>[];
  tables: Record<string, unknown>[];
  categories: Record<string, unknown>[];
  taxRates: Record<string, unknown>[];
  products: Record<string, unknown>[];
  stations: Record<string, unknown>[];
  devices: Record<string, unknown>[];
  stationOutputs: Record<string, unknown>[];
  routingRules: Record<string, unknown>[];
  modifierGroups: Record<string, unknown>[];
  modifiers: Record<string, unknown>[];
  roles: { id: string; name: string; isSystem: boolean; permissions: string[] }[];
  staff: {
    id: string;
    displayName: string;
    email: string | null;
    isActive: boolean;
    roleIds: string[];
    branchId: string | null;
  }[];
}

/** "How is the restaurant doing right now?" — today's business day of one branch. Real data only. */
export interface DashboardView {
  branchId: string;
  businessDay: string;
  currency: string;
  sales: {
    net: number;
    orders: number;
    averageOrder: number;
    byMethod: { method: 'cash' | 'momo' | 'card'; amount: number; count: number }[];
  };
  orders: {
    open: number;
    preparing: number;
    ready: number;
    awaitingPayment: number;
    completed: number;
    cancelled: number;
    takeawayOpen: number;
  };
  tables: { occupied: number; total: number };
  stations: {
    id: string;
    name: string;
    openTickets: number;
    delayedTickets: number;
    oldestTicketSeconds: number | null;
    targetPrepSeconds: number | null;
    readyToday: number;
    averagePrepSeconds: number | null;
  }[];
  inventory: { lowStockItems: number; openStockCounts: number };
  recentOrders: OrderSummaryView[];
  generatedAt: string;
}

/** Expediter / supervisor board: every active order with the progress of each of its stations. */
export interface ExpoOrderView {
  id: string;
  orderNumber: number;
  channel: OrderChannel;
  areaName: string;
  tableLabel: string | null;
  customerName: string | null;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  balanceDue: number;
  firstSubmittedAt: string | null;
  elapsedSeconds: number;
  stationsReady: number;
  stationsTotal: number;
  delayed: boolean;
  /** The not-ready station that has waited longest past its target, if any. */
  holdingStation: string | null;
  canHandOver: boolean;
  stations: {
    ticketId: string;
    stationId: string;
    stationName: string;
    status: TicketStatus;
    createdAt: string;
    readyAt: string | null;
    elapsedSeconds: number;
    targetPrepSeconds: number | null;
    delayed: boolean;
    items: { name: string; quantity: number; modifiers: string[]; notes: string | null; status: string }[];
  }[];
}
export interface ExpoView {
  branchId: string;
  orders: ExpoOrderView[];
  generatedAt: string;
}

export interface InventoryItemView {
  id: string;
  name: string;
  sku: string | null;
  category: string | null;
  unit: string;
  quantity: number;
  minQuantity: number;
  unitCost: number;
  value: number;
  isLow: boolean;
  isActive: boolean;
  lastMovementAt: string | null;
  usedIn: string[];
}
export interface InventoryView {
  branchId: string;
  currency: string;
  items: InventoryItemView[];
  totals: { items: number; lowStock: number; value: number };
}
export interface StockMovementView {
  id: string;
  itemId: string;
  itemName: string;
  unit: string;
  kind: 'receive' | 'waste' | 'adjust' | 'count' | 'sale';
  quantityDelta: number;
  quantityAfter: number;
  unitCost: number | null;
  reason: string | null;
  reference: string | null;
  staffName: string | null;
  createdAt: string;
}
export interface StockCountSummaryView {
  id: string;
  status: 'open' | 'submitted' | 'approved' | 'cancelled';
  note: string | null;
  startedAt: string;
  startedBy: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  lines: number;
  counted: number;
  variances: number;
  varianceValue: number;
}
export interface StockCountView extends StockCountSummaryView {
  version: number;
  items: {
    itemId: string;
    name: string;
    category: string | null;
    unit: string;
    systemQuantity: number;
    currentQuantity: number;
    countedQuantity: number | null;
    variance: number | null;
    varianceValue: number | null;
    reason: string | null;
  }[];
}
