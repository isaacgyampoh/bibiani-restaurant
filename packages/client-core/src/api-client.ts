import type {
  AgentConfigView,
  ApiErrorBody,
  CancelOrderCommand,
  ChangePinCommand,
  ClaimedPrintJobView,
  ClaimPrintJobsCommand,
  ConfigEntity,
  ConfigurationView,
  CreateStaffCommand,
  CustomerBoardView,
  DashboardView,
  ExpoView,
  FloorView,
  FulfilOrderCommand,
  HeartbeatCommand,
  InventoryView,
  ManualDiscountCommand,
  MenuView,
  MeView,
  OperationsView,
  OrderSummaryView,
  OrderView,
  PairingCodeView,
  PrintJobResultCommand,
  PrintQueueView,
  PrintReceiptCommand,
  PromotionPreviewView,
  PromotionView,
  ReceiptView,
  RecordCountLineCommand,
  RecordPaymentCommand,
  RecordStockMovementCommand,
  SalesReportView,
  SaveInventoryItemCommand,
  SavePromotionCommand,
  SaveRecipeCommand,
  SendToKitchenCommand,
  SetTableStatusCommand,
  StartStockCountCommand,
  StationBoardView,
  StockCountSummaryView,
  StockCountView,
  StockMovementView,
  SubmitOrderCommand,
  TicketActionCommand,
  TransferOrderCommand,
  UpdateStaffCommand,
  VoidItemsCommand,
} from '@rp/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly correlationId: string | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** No response at all: the request may or may not have reached the server. Safe to retry with the same ids. */
  static network(cause: unknown): ApiError {
    const e = new ApiError(
      0,
      'NETWORK',
      'No connection to the server. Your action will be retried.',
      true,
      null,
    );
    (e as { cause?: unknown }).cause = cause;
    return e;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
  /** POS/KDS the signed-in staff member is operating. */
  deviceId?: string | null;
  /** Alternative to deviceId when it can change at runtime (e.g. after pairing). */
  getDeviceId?: () => string | null;
  restaurantId?: string | null;
  timeoutMs?: number;
}

/** Typed client for the platform API. Every write carries client-generated ids, so retries are safe. */
export class ApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ApiClientOptions) {
    // Bound: browsers throw "Illegal invocation" when fetch is called with a foreign `this`.
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    // Files (product photos) go as raw bytes with their own type; everything else is JSON.
    const isFile = typeof Blob !== 'undefined' && body instanceof Blob;
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.options.getAccessToken()}`,
      'content-type': isFile ? (body as Blob).type || 'application/octet-stream' : 'application/json',
    };
    const deviceId = this.options.getDeviceId?.() ?? this.options.deviceId;
    if (deviceId) headers['x-device-id'] = deviceId;
    if (this.options.restaurantId) headers['x-restaurant-id'] = this.options.restaurantId;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : isFile ? (body as Blob) : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (cause) {
      throw ApiError.network(cause);
    }
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const err = (payload as ApiErrorBody | null)?.error;
      throw new ApiError(
        response.status,
        err?.code ?? 'HTTP_ERROR',
        err?.message ?? 'Something went wrong. Please try again.',
        err?.retryable ?? response.status >= 500,
        err?.correlationId ?? response.headers.get('x-request-id'),
      );
    }
    return payload as T;
  }

  submitOrder = (cmd: SubmitOrderCommand) => this.request<OrderView>('POST', '/v1/orders/submit', cmd);
  sendToKitchen = (orderId: string, cmd: SendToKitchenCommand) =>
    this.request<OrderView>('POST', `/v1/orders/${orderId}/send`, cmd);
  fulfilOrder = (orderId: string, cmd: FulfilOrderCommand = {}) =>
    this.request<OrderView>('POST', `/v1/orders/${orderId}/fulfil`, cmd);
  getOrder = (orderId: string) => this.request<OrderView>('GET', `/v1/orders/${orderId}`);
  dashboard = (branchId: string) => this.request<DashboardView>('GET', `/v1/branches/${branchId}/dashboard`);
  salesReport = (branchId: string, from: string, to: string) =>
    this.request<SalesReportView>('GET', `/v1/branches/${branchId}/reports/sales?from=${from}&to=${to}`);
  expo = (branchId: string) => this.request<ExpoView>('GET', `/v1/branches/${branchId}/expo`);
  inventory = (branchId: string) => this.request<InventoryView>('GET', `/v1/branches/${branchId}/inventory`);
  stockMovements = (branchId: string, itemId?: string) =>
    this.request<StockMovementView[]>(
      'GET',
      `/v1/branches/${branchId}/stock-movements${itemId ? `?itemId=${itemId}` : ''}`,
    );
  saveInventoryItem = (cmd: SaveInventoryItemCommand) =>
    this.request<{ id: string }>('POST', '/v1/inventory/items', cmd);
  recordStockMovement = (cmd: RecordStockMovementCommand) =>
    this.request<{ quantity: number }>('POST', '/v1/inventory/movements', cmd);
  stockCounts = (branchId: string) =>
    this.request<StockCountSummaryView[]>('GET', `/v1/branches/${branchId}/stock-counts`);
  startStockCount = (cmd: StartStockCountCommand) =>
    this.request<{ countId: string }>('POST', '/v1/stock-counts', cmd);
  stockCount = (countId: string) => this.request<StockCountView>('GET', `/v1/stock-counts/${countId}`);
  recordCountLine = (countId: string, cmd: RecordCountLineCommand) =>
    this.request<{ ok: true }>('POST', `/v1/stock-counts/${countId}/lines`, cmd);
  decideStockCount = (countId: string, action: 'submit' | 'approve' | 'cancel', expectedVersion: number) =>
    this.request<{ ok?: true; adjusted?: number }>('POST', `/v1/stock-counts/${countId}/${action}`, {
      expectedVersion,
    });
  recipe = (productId: string) =>
    this.request<{ itemId: string; name: string; unit: string; quantity: number }[]>(
      'GET',
      `/v1/products/${productId}/recipe`,
    );
  saveRecipe = (productId: string, cmd: SaveRecipeCommand) =>
    this.request<{ ok: true }>('POST', `/v1/products/${productId}/recipe`, cmd);
  transferOrder = (orderId: string, cmd: TransferOrderCommand) =>
    this.request<OrderView>('POST', `/v1/orders/${orderId}/transfer`, cmd);
  mergeOrders = (targetOrderId: string, sourceOrderId: string) =>
    this.request<OrderView>('POST', `/v1/orders/${targetOrderId}/merge`, { sourceOrderId });
  /** Uploads a product photo (already resized by the caller). */
  setProductImage = (productId: string, image: Blob) =>
    this.request<{ imageUrl: string }>('POST', `/v1/products/${productId}/image`, image);
  removeProductImage = (productId: string) =>
    this.request<{ ok: true }>('DELETE', `/v1/products/${productId}/image`);
  promotions = () => this.request<PromotionView[]>('GET', '/v1/promotions');
  previewPromotion = (cmd: SavePromotionCommand) =>
    this.request<PromotionPreviewView>('POST', '/v1/promotions/preview', cmd);
  savePromotion = (cmd: SavePromotionCommand) => this.request<{ id: string }>('POST', '/v1/promotions', cmd);
  setPromotionStatus = (id: string, action: 'activate' | 'pause' | 'end', expectedVersion: number) =>
    this.request<{ ok: true }>('POST', `/v1/promotions/${id}/status`, { action, expectedVersion });
  applyDiscount = (orderId: string, cmd: ManualDiscountCommand) =>
    this.request<OrderView>('POST', `/v1/orders/${orderId}/discount`, cmd);
  removeDiscount = (orderId: string) => this.request<OrderView>('DELETE', `/v1/orders/${orderId}/discount`);
  setPriority = (orderId: string, rush: boolean) =>
    this.request<OrderView>('POST', `/v1/orders/${orderId}/priority`, { rush });
  pinSignIn = (pin: string) =>
    this.request<{
      session: { accessToken: string; refreshToken: string; expiresAt: number };
      displayName: string;
      mustChangePin: boolean;
    }>('POST', '/v1/auth/pin', { pin });
  pinRecovery = (email: string) => this.request<{ ok: true }>('POST', '/v1/auth/pin-recovery', { email });
  changePin = (cmd: ChangePinCommand) => this.request<{ ok: true }>('POST', '/v1/me/pin', cmd);
  assignPin = (staffId: string, pin: string) =>
    this.request<{ ok: true }>('POST', `/v1/admin/staff/${staffId}/pin`, { pin });
  recentClosedOrders = (branchId: string) =>
    this.request<OrderSummaryView[]>('GET', `/v1/branches/${branchId}/orders/recent`);
  activeOrders = (branchId: string) =>
    this.request<OrderSummaryView[]>('GET', `/v1/branches/${branchId}/orders`);
  recordPayment = (orderId: string, cmd: RecordPaymentCommand) =>
    this.request<OrderView>('POST', `/v1/orders/${orderId}/payments`, cmd);
  stationBoard = (stationId: string) =>
    this.request<StationBoardView>('GET', `/v1/stations/${stationId}/board`);
  ticketAction = (ticketId: string, cmd: TicketActionCommand) =>
    this.request<OrderView>('POST', `/v1/tickets/${ticketId}/actions`, cmd);
  customerBoard = (branchId: string) =>
    this.request<CustomerBoardView>('GET', `/v1/branches/${branchId}/customer-board`);
  printQueue = (branchId: string) =>
    this.request<PrintQueueView>('GET', `/v1/branches/${branchId}/print-queue`);
  agentConfig = () => this.request<AgentConfigView>('GET', '/v1/print-agent/config');
  claimPrintJobs = (cmd: ClaimPrintJobsCommand) =>
    this.request<ClaimedPrintJobView[]>('POST', '/v1/print-agent/claim', cmd);
  reportPrintJob = (jobId: string, cmd: PrintJobResultCommand) =>
    this.request<{ status: string }>('POST', `/v1/print-jobs/${jobId}/result`, cmd);
  heartbeat = (cmd: HeartbeatCommand) => this.request<{ ok: true }>('POST', '/v1/devices/heartbeat', cmd);

  // Phase 4
  me = () => this.request<MeView>('GET', '/v1/me');
  menu = (branchId: string) => this.request<MenuView>('GET', `/v1/branches/${branchId}/menu`);
  floor = (branchId: string) => this.request<FloorView>('GET', `/v1/branches/${branchId}/floor`);
  operations = (branchId: string) =>
    this.request<OperationsView>('GET', `/v1/branches/${branchId}/operations`);
  setTableStatus = (tableId: string, cmd: SetTableStatusCommand) =>
    this.request<{ ok: true }>('POST', `/v1/tables/${tableId}/status`, cmd);
  cancelOrder = (orderId: string, cmd: CancelOrderCommand) =>
    this.request<OrderView>('POST', `/v1/orders/${orderId}/cancel`, cmd);
  voidItems = (orderId: string, cmd: VoidItemsCommand) =>
    this.request<OrderView>('POST', `/v1/orders/${orderId}/void-items`, cmd);
  markReady = (orderId: string) => this.request<OrderView>('POST', `/v1/orders/${orderId}/ready`, {});
  receipt = (orderId: string) => this.request<ReceiptView>('GET', `/v1/orders/${orderId}/receipt`);
  printReceipt = (orderId: string, cmd: PrintReceiptCommand) =>
    this.request<{ printJobId: string; isReprint: boolean }>(
      'POST',
      `/v1/orders/${orderId}/receipt/print`,
      cmd,
    );
  voidPayment = (paymentId: string, cmd: { reason: string }) =>
    this.request<OrderView>('POST', `/v1/payments/${paymentId}/void`, cmd);
  retryPrintJob = (jobId: string) =>
    this.request<{ status: string }>('POST', `/v1/print-jobs/${jobId}/retry`, {});
  configuration = () => this.request<ConfigurationView>('GET', '/v1/admin/configuration');
  saveConfig = (entity: ConfigEntity, record: unknown) =>
    this.request<{ id: string }>('POST', `/v1/admin/config/${entity}`, record);
  deleteConfig = (entity: ConfigEntity, id: string) =>
    this.request<{ deleted: boolean }>('DELETE', `/v1/admin/config/${entity}/${id}`);
  createStaff = (cmd: CreateStaffCommand) =>
    this.request<{ staffId: string }>('POST', '/v1/admin/staff', cmd);
  updateStaff = (staffId: string, cmd: UpdateStaffCommand) =>
    this.request<{ ok: true }>('POST', `/v1/admin/staff/${staffId}`, cmd);
  pairingCode = (deviceId: string) =>
    this.request<PairingCodeView>('POST', `/v1/admin/devices/${deviceId}/pairing-code`, {});
  revokeDevice = (deviceId: string) =>
    this.request<{ ok: true }>('POST', `/v1/admin/devices/${deviceId}/revoke`, {});
}
