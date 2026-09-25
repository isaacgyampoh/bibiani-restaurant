import type {
  ConfigEntity,
  ConfigurationView,
  CustomerBoardView,
  FloorView,
  MenuView,
  MeView,
  OperationsView,
  OrderSummaryView,
  OrderView,
  PrintQueueView,
  StationBoardView,
} from '@rp/contracts';
import type {
  DocumentBlock,
  OrderChannel,
  OrderItem,
  OrderItemStatus,
  OrderStatus,
  PaymentDirection,
  PaymentMethod,
  PaymentPolicy,
  PaymentRecord,
  PaymentStatus,
  PrintDocument,
  PrinterConnection,
  PrintJobKind,
  PrintJobStatus,
  PrintOutcome,
  ReceiptInput,
  RoutingRule,
  StationOutputRole,
  TableStatus,
  TicketStatus,
} from '@rp/domain';

// ---------------------------------------------------------------------------
// Cross-cutting ports
// ---------------------------------------------------------------------------
export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  uuid(): string;
}

/** Stable fingerprint of a command, used to detect a reused idempotency key with different content. */
export interface Fingerprinter {
  of(value: unknown): string;
}

export type LogFields = Record<string, unknown>;
export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/**
 * Runs `fn` inside ONE database transaction scoped to one restaurant. Every
 * write in a use case happens through the repositories handed to `fn`; if
 * anything throws, everything rolls back.
 */
export interface UnitOfWork {
  run<T>(restaurantId: string, fn: (tx: Repositories) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Records exchanged with repositories
// ---------------------------------------------------------------------------
export interface BranchRecord {
  id: string;
  name: string;
  timezone: string;
  businessDayCutoff: string;
  orderNumberStart: number;
  isActive: boolean;
}

export interface AreaRecord {
  id: string;
  branchId: string;
  name: string;
  channel: OrderChannel;
  requiresTable: boolean;
  requiresCustomerName: boolean;
  requirePaymentBeforeProduction: boolean;
  paymentPolicy: PaymentPolicy;
  isActive: boolean;
}

export interface TableRecord {
  id: string;
  branchId: string;
  areaId: string;
  label: string;
  status: TableStatus;
  isActive: boolean;
}

export interface OrderHeader {
  id: string;
  branchId: string;
  areaId: string;
  channel: OrderChannel;
  businessDay: string;
  orderNumber: number;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  tableId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  notes: string | null;
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
  paidTotal: number;
  refundedTotal: number;
  requestHash: string;
  version: number;
  createdAt: Date;
  firstSubmittedAt: Date | null;
  readyAt: Date | null;
  fulfilledAt: Date | null;
  completedAt: Date | null;
}

export interface StoredPayment extends PaymentRecord {
  orderId: string;
  requestHash: string;
}

export interface OrderAggregate {
  header: OrderHeader;
  items: OrderItem[];
  payments: StoredPayment[];
}

export type NewOrderHeader = Omit<
  OrderHeader,
  'version' | 'firstSubmittedAt' | 'readyAt' | 'fulfilledAt' | 'completedAt'
> & { createdByStaffId: string | null; createdByDeviceId: string | null; clientCreatedAt: Date | null };

export type OrderHeaderPatch = Partial<
  Pick<
    OrderHeader,
    | 'status'
    | 'paymentStatus'
    | 'subtotal'
    | 'taxTotal'
    | 'grandTotal'
    | 'paidTotal'
    | 'refundedTotal'
    | 'firstSubmittedAt'
    | 'readyAt'
    | 'fulfilledAt'
    | 'completedAt'
  >
> & { cancelledAt?: Date; cancelReason?: string; cancelledByStaffId?: string | null };

export interface ItemStatusUpdate {
  itemId: string;
  status: OrderItemStatus;
  stationId?: string;
  submissionId?: string;
  voidReason?: string;
  voidedByStaffId?: string | null;
}

export interface SubmissionRecord {
  id: string;
  orderId: string;
  seq: number;
  requestHash: string;
}

export interface OrderEvent {
  orderId: string;
  event: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  staffId: string | null;
  deviceId: string | null;
  correlationId: string;
  payload?: Record<string, unknown>;
}

export interface StationRecord {
  id: string;
  name: string;
  autoReady: boolean;
  isActive: boolean;
}

export interface StationOutputRecord {
  stationId: string;
  deviceId: string;
  deviceKind: 'printer' | 'kds' | string;
  role: StationOutputRole;
  copies: number;
  deviceActive: boolean;
  backupPrinterId: string | null;
  backupActive: boolean;
}

export interface RoutingSnapshot {
  stations: StationRecord[];
  outputs: StationOutputRecord[];
  rules: RoutingRule[];
  /** routing rule id -> active printer device ids that also receive the ticket */
  ruleExtraPrinters: Map<string, string[]>;
  categoryParents: Map<string, string | null>;
}

export interface NewTicket {
  id: string;
  branchId: string;
  orderId: string;
  submissionId: string;
  stationId: string;
  orderNumber: number;
  status: TicketStatus;
  itemIds: string[];
  readyAt: Date | null;
  createdAt: Date;
}

export interface TicketRecord {
  id: string;
  branchId: string;
  orderId: string;
  stationId: string;
  submissionId: string;
  status: TicketStatus;
  version: number;
  itemIds: string[];
}

export type TicketPatch = Partial<{
  status: TicketStatus;
  acceptedAt: Date;
  startedAt: Date;
  readyAt: Date | null;
  completedAt: Date | null;
}>;

export interface TicketEvent {
  ticketId: string;
  action: string;
  fromStatus: TicketStatus | null;
  toStatus: TicketStatus;
  staffId: string | null;
  deviceId: string | null;
  correlationId: string;
}

export interface NewPrintJob {
  id: string;
  branchId: string;
  printerId: string;
  originalPrinterId: string;
  kind: PrintJobKind;
  orderId: string | null;
  productionTicketId: string | null;
  copyNo: number;
  dedupeKey: string;
  document: PrintDocument;
  createdAt: Date;
  isReprint?: boolean;
}

export interface PrintJobRecord {
  id: string;
  branchId: string;
  printerId: string;
  originalPrinterId: string;
  kind: PrintJobKind;
  status: PrintJobStatus;
  attempts: number;
  maxAttempts: number;
  possibleDuplicate: boolean;
  claimId: string | null;
  claimedByDeviceId: string | null;
  leaseExpiresAt: Date | null;
  orderId: string | null;
  productionTicketId: string | null;
}

export type PrintJobPatch = Partial<{
  status: PrintJobStatus;
  attempts: number;
  maxAttempts: number;
  printerId: string;
  possibleDuplicate: boolean;
  nextAttemptAt: Date | null;
  claimId: string | null;
  claimedByDeviceId: string | null;
  leaseExpiresAt: Date | null;
  lastAttemptAt: Date;
  lastError: string | null;
  printedAt: Date | null;
  deadAt: Date | null;
}>;

export interface ClaimedPrintJob {
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
  leaseExpiresAt: Date;
}

export interface AgentPrinter {
  printerId: string;
  name: string;
  connection: PrinterConnection;
  address: string | null;
  paperWidthMm: number;
  isActive: boolean;
}

export interface NewPaymentRecord {
  id: string;
  branchId: string;
  orderId: string;
  direction: PaymentDirection;
  refundOfPaymentId: string | null;
  method: PaymentMethod;
  amount: number;
  tenderedAmount: number | null;
  changeAmount: number;
  reference: string | null;
  note: string | null;
  requestHash: string;
  recordedByStaffId: string | null;
  deviceId: string | null;
}

export interface AuditEntry {
  branchId: string | null;
  actorStaffId: string | null;
  actorDeviceId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  correlationId: string;
}

// ---------------------------------------------------------------------------
// Repositories (bound to one transaction)
// ---------------------------------------------------------------------------
export interface OrderRepository {
  /** Serialises concurrent requests for the same client order id (transaction-scoped). */
  lockOrderId(orderId: string): Promise<void>;
  findForUpdate(orderId: string): Promise<OrderAggregate | null>;
  allocateOrderNumber(branchId: string, businessDay: string, start: number): Promise<number>;
  orderExists(orderId: string): Promise<boolean>;
  findReservation(
    orderId: string,
  ): Promise<{ branchId: string; businessDay: string; orderNumber: number } | null>;
  insertReservation(r: {
    orderId: string;
    branchId: string;
    businessDay: string;
    orderNumber: number;
  }): Promise<void>;
  insertHeader(header: NewOrderHeader): Promise<void>;
  insertItems(orderId: string, items: readonly OrderItem[]): Promise<void>;
  updateItems(updates: readonly ItemStatusUpdate[], at: Date): Promise<void>;
  updateHeader(orderId: string, patch: OrderHeaderPatch, expectedVersion: number): Promise<number>;
  activeOrderIdForTable(tableId: string): Promise<string | null>;
  findSubmission(submissionId: string): Promise<SubmissionRecord | null>;
  /** Inserts the submission with the next sequence number for the order; returns that number. */
  insertSubmission(
    s: Omit<SubmissionRecord, 'seq'> & { staffId: string | null; deviceId: string | null; submittedAt: Date },
  ): Promise<number>;
  appendEvent(event: OrderEvent): Promise<void>;
}

export interface ConfigurationReader {
  branch(branchId: string): Promise<BranchRecord | null>;
  area(areaId: string): Promise<AreaRecord | null>;
  table(tableId: string): Promise<TableRecord | null>;
  setTableStatus(tableId: string, status: TableStatus, at: Date): Promise<void>;
  routingSnapshot(branchId: string): Promise<RoutingSnapshot>;
}

export interface CatalogReader {
  productsForSale(
    branchId: string,
    productIds: readonly string[],
  ): Promise<Map<string, import('@rp/domain').ProductForSale>>;
}

export interface ProductionRepository {
  insertTickets(tickets: readonly NewTicket[]): Promise<void>;
  find(ticketId: string): Promise<TicketRecord | null>;
  /** Printers that received this ticket (so void slips go to the same place). */
  printersForTicket(ticketId: string): Promise<string[]>;
  findForUpdate(ticketId: string): Promise<TicketRecord | null>;
  ticketsForOrder(orderId: string): Promise<TicketRecord[]>;
  update(ticketId: string, patch: TicketPatch, expectedVersion: number, at: Date): Promise<number>;
  appendEvent(event: TicketEvent): Promise<void>;
  appendEvents(events: readonly TicketEvent[]): Promise<void>;
}

export interface PrintJobRepository {
  insert(jobs: readonly NewPrintJob[]): Promise<void>;
  findByDedupeKey(key: string): Promise<{ id: string; isReprint: boolean } | null>;
  countForOrder(orderId: string, kind: 'receipt' | 'kitchen_ticket' | 'void_slip'): Promise<number>;
  receiptPrinterForDevice(deviceId: string): Promise<string | null>;
  printerInBranch(printerId: string, branchId: string): Promise<boolean>;
  idsForTickets(ticketIds: readonly string[]): Promise<string[]>;
  /** Jobs whose lease expired for printers driven by this agent (locked). */
  expiredLeases(agentDeviceId: string, now: Date): Promise<PrintJobRecord[]>;
  /** Locks and returns ready jobs (skip locked) for printers driven by this agent. */
  lockReady(agentDeviceId: string, now: Date, limit: number): Promise<PrintJobRecord[]>;
  findForUpdate(jobId: string): Promise<PrintJobRecord | null>;
  update(jobId: string, patch: PrintJobPatch): Promise<void>;
  claimed(jobIds: readonly string[]): Promise<ClaimedPrintJob[]>;
  appendAttempt(a: {
    jobId: string;
    claimId: string;
    agentDeviceId: string | null;
    printerId: string;
    outcome: PrintOutcome;
    error: string | null;
  }): Promise<void>;
  backupPrinterFor(printerId: string): Promise<string | null>;
  agentPrinters(agentDeviceId: string): Promise<AgentPrinter[]>;
  recordPrinterStatus(printerId: string, error: string | null, at: Date): Promise<void>;
}

export interface PaymentRepository {
  find(paymentId: string): Promise<StoredPayment | null>;
  insert(payment: NewPaymentRecord): Promise<void>;
  markVoided(paymentId: string, by: string | null, reason: string, at: Date): Promise<void>;
}

export interface DeviceRepository {
  heartbeat(
    deviceId: string,
    appVersion: string | null,
    at: Date,
  ): Promise<{ previousHeartbeatAt: Date | null }>;
  appendEvent(deviceId: string, event: string, detail: Record<string, unknown>): Promise<void>;
}

export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
}

/** Read models: denormalised, screen-shaped queries. */
export interface ReadModels {
  order(orderId: string): Promise<OrderView | null>;
  activeOrders(branchId: string): Promise<OrderSummaryView[]>;
  /** Closed orders (completed, cancelled, voided) of the current and previous business day, newest first. */
  recentClosedOrders(branchId: string): Promise<OrderSummaryView[]>;
  stationBoard(stationId: string): Promise<StationBoardView | null>;
  customerBoard(branchId: string, now: Date): Promise<CustomerBoardView>;
  printQueue(branchId: string): Promise<PrintQueueView>;
  menu(branchId: string): Promise<MenuView>;
  floor(branchId: string, now: Date): Promise<FloorView>;
  operations(branchId: string, now: Date): Promise<OperationsView>;
  receiptData(orderId: string): Promise<Omit<ReceiptInput, 'issuedAt'> | null>;
  configuration(): Promise<ConfigurationView>;
  me(principal: { staffId: string | null; deviceId: string | null }): Promise<{
    restaurant: { id: string; name: string; currency: string };
    branches: { id: string; name: string }[];
    device: MeView['device'];
  }>;
}

export interface Repositories {
  orders: OrderRepository;
  config: ConfigurationReader;
  catalog: CatalogReader;
  production: ProductionRepository;
  printJobs: PrintJobRepository;
  payments: PaymentRepository;
  devices: DeviceRepository;
  audit: AuditLog;
  read: ReadModels;
  admin: AdminRepository;
}

// ---------------------------------------------------------------------------
// Identity provider (Supabase Auth in production). Server-side only.
// ---------------------------------------------------------------------------
export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface AuthDirectory {
  createUser(input: {
    email: string;
    password: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }>;
  deleteUser(id: string): Promise<void>;
  updatePassword(id: string, password: string): Promise<void>;
  signIn(email: string, password: string): Promise<AuthSession>;
}

// ---------------------------------------------------------------------------
// Administration (tenant-scoped, runs inside the unit of work)
// ---------------------------------------------------------------------------
export interface AdminRepository {
  /** Returns the stored record (for audit before/after) or null. */
  get(entity: ConfigEntity, id: string): Promise<Record<string, unknown> | null>;
  /** Insert or update one configuration record; returns its id. */
  save(entity: ConfigEntity, record: Record<string, unknown>): Promise<string>;
  delete(entity: ConfigEntity, id: string): Promise<boolean>;
  insertStaff(s: { id: string; userId: string; displayName: string; email: string }): Promise<void>;
  updateStaff(id: string, patch: { displayName?: string; isActive?: boolean }): Promise<void>;
  setStaffRoles(staffId: string, roleIds: readonly string[], branchId: string | null): Promise<void>;
  staff(
    staffId: string,
  ): Promise<{ id: string; userId: string | null; displayName: string; isActive: boolean } | null>;
  insertPairingCode(p: {
    deviceId: string;
    codeHash: string;
    expiresAt: Date;
    createdByStaffId: string | null;
  }): Promise<void>;
  device(deviceId: string): Promise<{
    id: string;
    branchId: string;
    kind: string;
    name: string;
    authUserId: string | null;
    isActive: boolean;
  } | null>;
  unbindDeviceIdentity(deviceId: string): Promise<void>;
  setTableStatus(
    tableId: string,
    status: 'available' | 'reserved' | 'out_of_service',
  ): Promise<{ branchId: string } | null>;
}

/**
 * The only operations that run before a tenant is known: redeeming a pairing
 * code and binding the device's new login. Backed by narrow SECURITY DEFINER
 * functions (migration 1100).
 */
export interface IdentityRegistry {
  redeemPairingCode(
    codeHash: string,
    now: Date,
  ): Promise<{
    deviceId: string;
    restaurantId: string;
    branchId: string;
    kind: string;
    name: string;
    stationId: string | null;
    previousAuthUserId: string | null;
  } | null>;
  bindDeviceIdentity(deviceId: string, authUserId: string): Promise<void>;
}

/** Cryptographically secure random values. */
export interface SecretGenerator {
  /** Short human-typable one-time code (unambiguous alphabet). */
  pairingCode(): string;
  password(): string;
}
