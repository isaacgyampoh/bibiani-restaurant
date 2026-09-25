import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Application, Logger, RequestContext } from '@rp/application';
import {
  CancelOrderCommand,
  ClaimPrintJobsCommand,
  CONFIG_ENTITIES,
  type ConfigEntity,
  CreateStaffCommand,
  FulfilOrderCommand,
  HeartbeatCommand,
  PairDeviceCommand,
  PrintJobResultCommand,
  PrintReceiptCommand,
  RecordCountLineCommand,
  RecordPaymentCommand,
  RecordStockMovementCommand,
  RefundPaymentCommand,
  SaveInventoryItemCommand,
  SaveRecipeCommand,
  SendToKitchenCommand,
  SetTableStatusCommand,
  StartStockCountCommand,
  StockCountDecisionCommand,
  SubmitOrderCommand,
  TicketActionCommand,
  UpdateStaffCommand,
  VoidItemsCommand,
  VoidPaymentCommand,
} from '@rp/contracts';
import { DomainError } from '@rp/domain';
import {
  type AccessTokenVerifier,
  InfrastructureError,
  InvalidTokenError,
  type PgPrincipalResolver,
  translatePgError,
  withRequestMetrics,
} from '@rp/infrastructure';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import type { z } from 'zod';
import { toHttpError } from './errors';
import type { ReadinessReport } from './health';
import { RateLimiter } from './rate-limit';

type Env = {
  Variables: { correlationId: string; ctx: RequestContext; operation: string; displayName: string };
};

export interface HttpDependencies {
  app: Application;
  verifier: AccessTokenVerifier;
  resolver: Pick<PgPrincipalResolver, 'resolve' | 'validateOperatingDevice'>;
  logger: Logger;
  readiness?: () => Promise<ReadinessReport>;
  release?: string;
  /** Browser origins allowed to call the API (web app). Empty = same-origin only. */
  allowedOrigins?: readonly string[];
  /** Operational counters and the cross-restaurant health summary (counts only). */
  ops?: { record(kind: 'http_5xx' | 'auth_failure'): Promise<void>; health(): Promise<unknown> };
  /** Bearer token for GET /v1/ops/health (external monitor). Unset = endpoint disabled. */
  monitorToken?: string;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * HTTP presentation layer. Every route: validate input -> call ONE use case ->
 * return its view. No SQL, no business rules, no Supabase calls here.
 */
export function createHttpApp(deps: HttpDependencies) {
  const http = new Hono<Env>();

  http.use('*', async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const correlationId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    c.set('correlationId', correlationId);
    c.set('operation', 'default');
    const started = performance.now();
    const { metrics } = await withRequestMetrics(() => next());
    const status = c.res.status;
    if (deps.ops && (status >= 500 || status === 401)) {
      // Best effort and bounded: monitoring must never break or stall the response.
      await Promise.race([
        deps.ops.record(status >= 500 ? 'http_5xx' : 'auth_failure').catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    c.header('x-request-id', correlationId);
    const totalMs = performance.now() - started;
    // Server-side timing for performance measurement (visible to clients and load tests).
    c.header(
      'server-timing',
      `total;dur=${totalMs.toFixed(1)}, db;dur=${metrics.dbMs.toFixed(1)};desc="${metrics.statements} statements, ${metrics.transactions} tx"`,
    );
    deps.logger.info('http.request', {
      correlationId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(totalMs),
      dbMs: Math.round(metrics.dbMs),
      dbStatements: metrics.statements,
      restaurantId: c.var.ctx?.principal.restaurantId,
      deviceId: c.var.ctx?.deviceId,
    });
  });

  if (deps.allowedOrigins?.length) {
    http.use(
      '*',
      cors({
        origin: [...deps.allowedOrigins],
        allowHeaders: ['authorization', 'content-type', 'x-device-id', 'x-restaurant-id', 'x-request-id'],
        exposeHeaders: ['x-request-id'],
        maxAge: 600,
      }),
    );
  }

  http.onError((error, c) => {
    const correlationId = c.var.correlationId ?? randomUUID();
    // Database/driver errors that escaped a unit of work (e.g. during sign-in resolution) get the same safe translation.
    const translated =
      error instanceof DomainError ||
      error instanceof InfrastructureError ||
      error instanceof InvalidTokenError
        ? error
        : typeof (error as { code?: unknown }).code === 'string'
          ? translatePgError(error)
          : error;
    const mapped = toHttpError(translated, c.var.operation ?? 'default', correlationId);
    deps.logger[mapped.level]('http.error', {
      correlationId,
      operation: c.var.operation,
      path: c.req.path,
      code: mapped.body.error.code,
      status: mapped.status,
      error,
      details: error instanceof DomainError ? error.details : undefined,
    });
    return c.json(mapped.body, mapped.status);
  });

  // Liveness: the process is up. No dependencies checked (cheap, for load balancers).
  http.get('/health', (c) => c.json({ status: 'ok', release: deps.release ?? 'local' }));
  // Readiness: database, schema version, Auth keys (+ Realtime storage, reported only).
  http.get('/health/ready', async (c) => {
    if (!deps.readiness) return c.json({ status: 'ready' });
    const report = await deps.readiness();
    return c.json(report, report.status === 'ready' ? 200 : 503);
  });

  // External monitor: cross-restaurant counts (5xx, auth failures, printing). Token-protected, no tenant data.
  http.get('/v1/ops/health', async (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!deps.ops || !deps.monitorToken || deps.monitorToken.length < 32) return c.notFound();
    if (!timingSafeEqual(digest(token), digest(deps.monitorToken)))
      return c.json({ error: 'forbidden' }, 403);
    return c.json(await deps.ops.health());
  });

  // Device pairing is the one unauthenticated write: rate limited per client address.
  const pairingLimiter = new RateLimiter(5, 60_000);
  http.post('/v1/devices/pair', async (c) => {
    c.set('operation', 'pair_device');
    const client =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? 'local';
    if (!pairingLimiter.allow(client)) {
      deps.logger.warn('device.pairing_rate_limited', { correlationId: c.var.correlationId, client });
      return c.json(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many attempts. Wait a minute and try again.',
            correlationId: c.var.correlationId,
            retryable: true,
          },
        },
        429,
      );
    }
    return c.json(await deps.app.pairDevice.execute(await body(c, PairDeviceCommand), c.var.correlationId));
  });

  // Name the operation before authentication, so even an auth-stage failure gets an operation-specific message.
  http.use('/v1/*', async (c, next) => {
    const path = c.req.path;
    const name =
      c.req.method !== 'POST'
        ? 'default'
        : path.startsWith('/v1/stock-counts')
          ? 'stock_count'
          : path.startsWith('/v1/inventory')
            ? 'save_stock'
            : /\/recipe$/.test(path)
              ? 'save_recipe'
              : path === '/v1/orders/submit'
                ? 'submit_order'
                : /\/send$/.test(path)
                  ? 'send_to_kitchen'
                  : /\/payments$/.test(path)
                    ? 'record_payment'
                    : /\/void$/.test(path)
                      ? 'void_payment'
                      : /\/refunds$/.test(path)
                        ? 'refund_payment'
                        : /\/actions$/.test(path) || /\/ready$/.test(path)
                          ? 'ticket_action'
                          : /\/fulfil$/.test(path)
                            ? 'fulfil_order'
                            : /\/cancel$/.test(path)
                              ? 'cancel_order'
                              : /\/void-items$/.test(path)
                                ? 'void_items'
                                : /\/receipt\/print$/.test(path)
                                  ? 'print_receipt'
                                  : path.startsWith('/v1/admin/staff')
                                    ? 'save_staff'
                                    : path.startsWith('/v1/admin/config')
                                      ? 'save_config'
                                      : 'default';
    c.set('operation', name);
    await next();
  });

  // Authentication: verified token -> membership lookup -> Principal.
  http.use('/v1/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new DomainError('FORBIDDEN', 'Missing access token');
    const verified = await deps.verifier.verify(token);
    const requested = c.req.header('x-restaurant-id') ?? null;
    const resolved = await deps.resolver.resolve(
      verified.authUserId,
      requested && UUID.test(requested) ? requested : null,
    );
    if (!resolved.ok) {
      deps.logger.warn('auth.denied', { correlationId: c.var.correlationId, reason: resolved.reason });
      throw new DomainError('FORBIDDEN', 'This account has no access here', { reason: resolved.reason });
    }
    const principal = resolved.principal;
    let deviceId: string | null = principal.kind === 'device' ? principal.deviceId : null;
    const operating = c.req.header('x-device-id');
    if (principal.kind === 'staff' && operating) {
      if (
        !UUID.test(operating) ||
        !(await deps.resolver.validateOperatingDevice(principal.restaurantId, operating))
      ) {
        throw new DomainError('FORBIDDEN', 'Unknown device', { deviceId: operating });
      }
      deviceId = operating;
    }
    c.set('ctx', { principal, correlationId: c.var.correlationId, deviceId });
    c.set('displayName', resolved.displayName);
    await next();
  });

  const body = async <S extends z.ZodType>(c: Context<Env>, schema: S): Promise<z.infer<S>> => {
    const raw = await c.req.json().catch(() => {
      throw new DomainError('VALIDATION_FAILED', 'The request could not be read');
    });
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', 'Some details are missing or invalid', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return parsed.data;
  };
  const id = (c: Context<Env>, name: string): string => {
    const value = c.req.param(name) ?? '';
    if (!UUID.test(value)) throw new DomainError('NOT_FOUND', 'Not found');
    return value;
  };
  const op = (c: Context<Env>, name: string) => c.set('operation', name);
  const entity = (c: Context<Env>): ConfigEntity => {
    const value = c.req.param('entity') as ConfigEntity;
    if (!CONFIG_ENTITIES.includes(value)) throw new DomainError('NOT_FOUND', 'Not found');
    return value;
  };

  const v1 = http.basePath('/v1');

  // Orders
  v1.post('/orders/submit', async (c) => {
    op(c, 'submit_order');
    return c.json(await deps.app.submitOrder.execute(c.var.ctx, await body(c, SubmitOrderCommand)));
  });
  v1.post('/orders/:orderId/send', async (c) => {
    op(c, 'send_to_kitchen');
    return c.json(
      await deps.app.sendOrderToKitchen.execute(
        c.var.ctx,
        id(c, 'orderId'),
        await body(c, SendToKitchenCommand),
      ),
    );
  });
  v1.post('/orders/:orderId/fulfil', async (c) => {
    op(c, 'fulfil_order');
    return c.json(
      await deps.app.fulfilOrder.execute(c.var.ctx, id(c, 'orderId'), await body(c, FulfilOrderCommand)),
    );
  });
  v1.get('/orders/:orderId', async (c) =>
    c.json(await deps.app.getOrder.execute(c.var.ctx, id(c, 'orderId'))),
  );
  v1.get('/branches/:branchId/orders/recent', async (c) =>
    c.json(await deps.app.listRecentClosedOrders.execute(c.var.ctx, id(c, 'branchId'))),
  );
  v1.get('/branches/:branchId/orders', async (c) =>
    c.json(await deps.app.listActiveOrders.execute(c.var.ctx, id(c, 'branchId'))),
  );

  // Payments (manual recording)
  v1.post('/orders/:orderId/payments', async (c) => {
    op(c, 'record_payment');
    return c.json(
      await deps.app.recordPayment.execute(c.var.ctx, id(c, 'orderId'), await body(c, RecordPaymentCommand)),
    );
  });
  v1.post('/payments/:paymentId/void', async (c) => {
    op(c, 'void_payment');
    return c.json(
      await deps.app.voidPayment.execute(c.var.ctx, id(c, 'paymentId'), await body(c, VoidPaymentCommand)),
    );
  });
  v1.post('/payments/:paymentId/refunds', async (c) => {
    op(c, 'refund_payment');
    return c.json(
      await deps.app.refundPayment.execute(
        c.var.ctx,
        id(c, 'paymentId'),
        await body(c, RefundPaymentCommand),
      ),
    );
  });

  // Kitchen
  v1.get('/stations/:stationId/board', async (c) =>
    c.json(await deps.app.getStationBoard.execute(c.var.ctx, id(c, 'stationId'))),
  );
  v1.post('/tickets/:ticketId/actions', async (c) => {
    op(c, 'ticket_action');
    return c.json(
      await deps.app.transitionTicket.execute(
        c.var.ctx,
        id(c, 'ticketId'),
        await body(c, TicketActionCommand),
      ),
    );
  });

  // Customer display
  v1.get('/branches/:branchId/customer-board', async (c) =>
    c.json(await deps.app.getCustomerBoard.execute(c.var.ctx, id(c, 'branchId'))),
  );

  // Printing
  v1.get('/print-agent/config', async (c) => c.json(await deps.app.getAgentConfig.execute(c.var.ctx)));
  v1.post('/print-agent/claim', async (c) =>
    c.json(await deps.app.claimPrintJobs.execute(c.var.ctx, await body(c, ClaimPrintJobsCommand))),
  );
  v1.post('/print-jobs/:jobId/result', async (c) =>
    c.json(
      await deps.app.reportPrintJobResult.execute(
        c.var.ctx,
        id(c, 'jobId'),
        await body(c, PrintJobResultCommand),
      ),
    ),
  );
  v1.post('/print-jobs/:jobId/retry', async (c) =>
    c.json(await deps.app.retryPrintJob.execute(c.var.ctx, id(c, 'jobId'))),
  );
  v1.get('/branches/:branchId/print-queue', async (c) =>
    c.json(await deps.app.getPrintQueue.execute(c.var.ctx, id(c, 'branchId'))),
  );

  // Order corrections & receipts
  v1.post('/orders/:orderId/cancel', async (c) => {
    op(c, 'cancel_order');
    return c.json(
      await deps.app.cancelOrder.execute(c.var.ctx, id(c, 'orderId'), await body(c, CancelOrderCommand)),
    );
  });
  v1.post('/orders/:orderId/void-items', async (c) => {
    op(c, 'void_items');
    return c.json(
      await deps.app.voidItems.execute(c.var.ctx, id(c, 'orderId'), await body(c, VoidItemsCommand)),
    );
  });
  v1.post('/orders/:orderId/ready', async (c) => {
    op(c, 'ticket_action');
    return c.json(await deps.app.markOrderReady.execute(c.var.ctx, id(c, 'orderId')));
  });
  v1.get('/orders/:orderId/receipt', async (c) =>
    c.json(await deps.app.getReceipt.execute(c.var.ctx, id(c, 'orderId'))),
  );
  v1.post('/orders/:orderId/receipt/print', async (c) => {
    op(c, 'print_receipt');
    return c.json(
      await deps.app.printReceipt.execute(c.var.ctx, id(c, 'orderId'), await body(c, PrintReceiptCommand)),
    );
  });

  // Session, menu, hall
  v1.get('/me', async (c) => c.json(await deps.app.getMe.execute(c.var.ctx, c.var.displayName)));
  v1.get('/branches/:branchId/menu', async (c) =>
    c.json(await deps.app.getMenu.execute(c.var.ctx, id(c, 'branchId'))),
  );
  v1.get('/branches/:branchId/floor', async (c) =>
    c.json(await deps.app.getFloor.execute(c.var.ctx, id(c, 'branchId'))),
  );
  v1.post('/tables/:tableId/status', async (c) =>
    c.json(
      await deps.app.setTableStatus.execute(
        c.var.ctx,
        id(c, 'tableId'),
        await body(c, SetTableStatusCommand),
      ),
    ),
  );
  v1.get('/branches/:branchId/operations', async (c) =>
    c.json(await deps.app.getOperationsStatus.execute(c.var.ctx, id(c, 'branchId'))),
  );

  // Restaurant operations: dashboard and expediter board
  v1.get('/branches/:branchId/dashboard', async (c) =>
    c.json(await deps.app.getDashboard.execute(c.var.ctx, id(c, 'branchId'))),
  );
  v1.get('/branches/:branchId/expo', async (c) =>
    c.json(await deps.app.getExpoBoard.execute(c.var.ctx, id(c, 'branchId'))),
  );

  // Inventory and stock taking
  v1.get('/branches/:branchId/inventory', async (c) =>
    c.json(await deps.app.listInventory.execute(c.var.ctx, id(c, 'branchId'))),
  );
  v1.get('/branches/:branchId/stock-movements', async (c) => {
    const itemId = c.req.query('itemId');
    if (itemId && !UUID.test(itemId)) throw new DomainError('VALIDATION_FAILED', 'Invalid item');
    return c.json(await deps.app.listStockMovements.execute(c.var.ctx, id(c, 'branchId'), itemId ?? null));
  });
  v1.post('/inventory/items', async (c) =>
    c.json(await deps.app.saveInventoryItem.execute(c.var.ctx, await body(c, SaveInventoryItemCommand))),
  );
  v1.post('/inventory/movements', async (c) =>
    c.json(await deps.app.recordStockMovement.execute(c.var.ctx, await body(c, RecordStockMovementCommand))),
  );
  v1.get('/branches/:branchId/stock-counts', async (c) =>
    c.json(await deps.app.listStockCounts.execute(c.var.ctx, id(c, 'branchId'))),
  );
  v1.post('/stock-counts', async (c) =>
    c.json(await deps.app.startStockCount.execute(c.var.ctx, await body(c, StartStockCountCommand))),
  );
  v1.get('/stock-counts/:countId', async (c) =>
    c.json(await deps.app.getStockCount.execute(c.var.ctx, id(c, 'countId'))),
  );
  v1.post('/stock-counts/:countId/lines', async (c) =>
    c.json(
      await deps.app.recordCountLine.execute(
        c.var.ctx,
        id(c, 'countId'),
        await body(c, RecordCountLineCommand),
      ),
    ),
  );
  for (const [action, useCase] of [
    ['submit', deps.app.submitStockCount],
    ['approve', deps.app.approveStockCount],
    ['cancel', deps.app.cancelStockCount],
  ] as const) {
    v1.post(`/stock-counts/:countId/${action}`, async (c) =>
      c.json(await useCase.execute(c.var.ctx, id(c, 'countId'), await body(c, StockCountDecisionCommand))),
    );
  }
  v1.get('/products/:productId/recipe', async (c) =>
    c.json(await deps.app.getRecipe.execute(c.var.ctx, id(c, 'productId'))),
  );
  v1.post('/products/:productId/recipe', async (c) =>
    c.json(
      await deps.app.saveRecipe.execute(c.var.ctx, id(c, 'productId'), await body(c, SaveRecipeCommand)),
    ),
  );

  // Administration
  v1.get('/admin/configuration', async (c) => c.json(await deps.app.getConfiguration.execute(c.var.ctx)));
  v1.post('/admin/config/:entity', async (c) => {
    op(c, 'save_config');
    return c.json(
      await deps.app.saveConfig.execute(c.var.ctx, entity(c), await c.req.json().catch(() => null)),
    );
  });
  v1.delete('/admin/config/:entity/:configId', async (c) => {
    op(c, 'save_config');
    return c.json(await deps.app.deleteConfig.execute(c.var.ctx, entity(c), id(c, 'configId')));
  });
  v1.post('/admin/staff', async (c) => {
    op(c, 'save_staff');
    return c.json(await deps.app.createStaff.execute(c.var.ctx, await body(c, CreateStaffCommand)));
  });
  v1.post('/admin/staff/:staffId', async (c) => {
    op(c, 'save_staff');
    return c.json(
      await deps.app.updateStaff.execute(c.var.ctx, id(c, 'staffId'), await body(c, UpdateStaffCommand)),
    );
  });
  v1.post('/admin/devices/:deviceId/pairing-code', async (c) =>
    c.json(await deps.app.createPairingCode.execute(c.var.ctx, id(c, 'deviceId'))),
  );
  v1.post('/admin/devices/:deviceId/revoke', async (c) =>
    c.json(await deps.app.revokeDevice.execute(c.var.ctx, id(c, 'deviceId'))),
  );

  // Devices
  v1.post('/devices/heartbeat', async (c) =>
    c.json(await deps.app.recordHeartbeat.execute(c.var.ctx, await body(c, HeartbeatCommand))),
  );

  return http;
}
