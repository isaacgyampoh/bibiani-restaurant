import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Application, Logger, RequestContext } from '@rp/application';
import {
  type ActivityCategory,
  ApprovePairingCommand,
  AssignPinCommand,
  CancelOrderCommand,
  ChangePinCommand,
  ClaimPrintJobsCommand,
  CloseRegisterCommand,
  CONFIG_ENTITIES,
  CollectPairingCommand,
  type ConfigEntity,
  CreateCustomerCommand,
  CreateStaffCommand,
  EmailLinkCommand,
  EmailPinSignInCommand,
  EXPORT_FORMATS,
  type ExportFormat,
  FulfilOrderCommand,
  HeartbeatCommand,
  HubBatchCommand,
  HubPinChangeCommand,
  HubPinVerifyCommand,
  ManualDiscountCommand,
  MergeCustomerCommand,
  MergeOrderCommand,
  OnboardingAcceptCommand,
  OnboardingStartCommand,
  OpenRegisterCommand,
  OrderPriorityCommand,
  PairDeviceCommand,
  PairingRequestCommand,
  PinRecoveryCommand,
  PinSignInCommand,
  PrintJobResultCommand,
  PrintReceiptCommand,
  REPORT_KINDS,
  RecordCountLineCommand,
  RecordPaymentCommand,
  RecordStockMovementCommand,
  RefundPaymentCommand,
  ReopenRegisterCommand,
  type ReportKind,
  ReportQuery,
  type ReportView,
  RequestBillCommand,
  SaveInventoryItemCommand,
  SavePromotionCommand,
  SaveRecipeCommand,
  SendToKitchenCommand,
  SetBranchHubCommand,
  SetOrderCustomerCommand,
  SetPromotionStatusCommand,
  SetTableStatusCommand,
  StartStockCountCommand,
  StockCountDecisionCommand,
  SubmitOrderCommand,
  TestPrintCommand,
  TicketActionCommand,
  TransferOrderCommand,
  UpdateCustomerCommand,
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
import { renderReport } from '@rp/report-export';
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
  resolver: Pick<PgPrincipalResolver, 'resolve' | 'validateOperatingDevice' | 'pinSession'>;
  logger: Logger;
  readiness?: () => Promise<ReadinessReport>;
  release?: string;
  /** Browser origins allowed to call the API (web app). Empty = same-origin only. */
  allowedOrigins?: readonly string[];
  /** Operational counters and the cross-restaurant health summary (counts only). */
  ops?: { record(kind: 'http_5xx' | 'auth_failure'): Promise<void>; health(): Promise<unknown> };
  /** Bearer token for GET /v1/ops/health (external monitor). Unset = endpoint disabled. */
  monitorToken?: string;
  /**
   * Staff PIN sign-in and PIN changes. Default: the application's use cases. The in-store hub
   * supplies its own (offline PIN copies, changes forwarded to the cloud).
   */
  pins?: {
    signIn(ctx: RequestContext, pin: string): ReturnType<Application['pinSignIn']['execute']>;
    changeOwnPin(
      ctx: RequestContext,
      cmd: { currentPin?: string | null; newPin: string },
    ): Promise<{ ok: true }>;
  };
}

/**
 * password: email + password. pin: a PIN sign-in on a registered device (bound server side).
 * email_link: a session opened from an emailed link (recovery / magic link / invite): "otp" sessions
 * that are NOT a bound PIN session. Without a session id an "otp" session is treated as a PIN.
 */
async function signInMethod(
  verified: { authMethods: string[]; sessionId?: string | null },
  bound: unknown,
): Promise<'password' | 'pin' | 'email_link'> {
  const m = verified.authMethods;
  if (m.includes('recovery') || m.includes('invite')) return 'email_link';
  if (m.includes('otp') || m.includes('magiclink'))
    return bound || !verified.sessionId ? 'pin' : 'email_link';
  return 'password';
}

const digest = (value: string) => createHash('sha256').update(value).digest();

const ACTIVITY_CATEGORIES: readonly ActivityCategory[] = [
  'menu',
  'promotions',
  'payments',
  'orders',
  'inventory',
  'staff',
  'setup',
];
const PASSWORD_ONLY: ReadonlySet<string> = new Set(['staff.manage', 'device.manage', 'config.manage']);
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

  // Device-initiated pairing (the device shows a code). Both device-side calls are public.
  // Per network address. A restaurant's screens all share one address, and each waiting screen asks
  // every 3 seconds, so the limits allow several screens at once. Codes (8 characters, 10 minutes,
  // one use) and secrets (256 bits) are not guessable within these limits.
  const pairingRequestLimiter = new RateLimiter(30, 60_000);
  const pairingCollectLimiter = new RateLimiter(400, 60_000);
  const clientOf = (c: Context<Env>) =>
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? 'local';
  http.post('/v1/devices/pairing-requests', async (c) => {
    if (!pairingRequestLimiter.allow(clientOf(c)))
      throw new DomainError('RATE_LIMITED', 'Too many attempts. Wait a minute and try again.');
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = PairingRequestCommand.safeParse(raw ?? {});
    return c.json(await deps.app.requestDevicePairing.execute(parsed.success ? parsed.data : {}));
  });
  http.post('/v1/devices/pairing-requests/collect', async (c) => {
    if (!pairingCollectLimiter.allow(clientOf(c)))
      throw new DomainError('RATE_LIMITED', 'Too many attempts. Wait a minute and try again.');
    const { secret } = await body(c, CollectPairingCommand);
    return c.json(await deps.app.collectDevicePairing.execute(secret, c.var.correlationId));
  });

  // Owner onboarding. Start is public (rate limited; same answer for every email). Accept needs the
  // session from the emailed link but no restaurant membership yet, so it verifies the token itself.
  const onboardingLimiter = new RateLimiter(5, 60_000);
  http.post('/v1/onboarding/start', async (c) => {
    const client =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? 'local';
    if (!onboardingLimiter.allow(client))
      throw new DomainError('RATE_LIMITED', 'Too many attempts. Wait a minute and try again.');
    const { email } = await body(c, OnboardingStartCommand);
    return c.json(await deps.app.startOwnerOnboarding.execute({ email, correlationId: c.var.correlationId }));
  });
  http.post('/v1/onboarding/accept', async (c) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new DomainError('FORBIDDEN', 'Open the link from your email to finish setting up');
    const verified = await deps.verifier.verify(token);
    const { fullName, pin } = await body(c, OnboardingAcceptCommand);
    const method = await signInMethod(
      verified,
      verified.sessionId ? await deps.resolver.pinSession(verified.sessionId) : null,
    );
    return c.json(
      await deps.app.acceptOwnerInvitation.execute({
        authUserId: verified.authUserId,
        // Only a session opened from an email link proves the address.
        authMethods: method === 'email_link' ? ['recovery'] : [method],
        fullName,
        pin,
        correlationId: c.var.correlationId,
      }),
    );
  });
  // "Email me a sign-in link" (public, rate limited, same answer for every address).
  http.post('/v1/auth/email-link', async (c) => {
    const client =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? 'local';
    if (!onboardingLimiter.allow(client))
      throw new DomainError('RATE_LIMITED', 'Too many attempts. Wait a minute and try again.');
    const { email } = await body(c, EmailLinkCommand);
    return c.json(await deps.app.sendSignInLink.execute({ email, correlationId: c.var.correlationId }));
  });

  // Owner / manager on a new phone or laptop: email + PIN registers the device (public, rate limited).
  const emailPinLimiter = new RateLimiter(10, 60_000);
  http.post('/v1/auth/email-pin', async (c) => {
    const client =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? 'local';
    if (!emailPinLimiter.allow(client))
      throw new DomainError('RATE_LIMITED', 'Too many attempts. Wait a minute and try again.');
    const { email, pin } = await body(c, EmailPinSignInCommand);
    return c.json(
      await deps.app.signInWithEmailAndPin.execute({ email, pin, correlationId: c.var.correlationId }),
    );
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
              : /\/image$/.test(path)
                ? 'save_photo'
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
    // How this session was opened. Supabase marks email-link sessions (recovery / magic link) AND
    // our PIN sessions (server-issued magic-link sessions) both as "otp": the server-side binding
    // recorded at every PIN sign-in is what tells them apart.
    const bound = verified.sessionId ? await deps.resolver.pinSession(verified.sessionId) : null;
    const authMethod = await signInMethod(verified, bound);
    if (bound && !bound.deviceUsable)
      throw new DomainError('FORBIDDEN', 'This device was removed. Sign in again on a paired device.', {
        reason: 'device_removed',
      });
    let deviceId: string | null = resolved.principal.kind === 'device' ? resolved.principal.deviceId : null;
    const operating = c.req.header('x-device-id');
    if (resolved.principal.kind === 'staff' && operating) {
      if (
        !UUID.test(operating) ||
        !(await deps.resolver.validateOperatingDevice(resolved.principal.restaurantId, operating))
      ) {
        throw new DomainError('FORBIDDEN', 'Unknown device', { deviceId: operating });
      }
      deviceId = operating;
    }
    // A PIN session runs on the device it was signed in on (server-side binding, not the header).
    // On a SHARED till it unlocks operations, not administration: staff, device and settings
    // management need a password sign-in, or the person's OWN registered (personal) device.
    let ownDevice = false;
    if (authMethod === 'pin' && resolved.principal.kind === 'staff') {
      if (bound && bound.staffId === resolved.principal.staffId) {
        if (deviceId && deviceId !== bound.deviceId)
          throw new DomainError('FORBIDDEN', 'This sign-in belongs to another device');
        deviceId = bound.deviceId;
        ownDevice = bound.personalStaffId === resolved.principal.staffId;
      }
    }
    const principal =
      authMethod === 'pin' && resolved.principal.kind === 'staff' && !ownDevice
        ? {
            ...resolved.principal,
            grants: resolved.principal.grants.map((g) => ({
              branchId: g.branchId,
              permissions: new Set([...g.permissions].filter((perm) => !PASSWORD_ONLY.has(perm))),
            })),
          }
        : resolved.principal;
    c.set('ctx', { principal, correlationId: c.var.correlationId, deviceId, authMethod });
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
  // In-store hub sync (docs/OFFLINE-ARCHITECTURE.md). Hub device logins only.
  v1.get('/hub/snapshot', async (c) => {
    const since = c.req.query('since') ?? null;
    if (since !== null && Number.isNaN(Date.parse(since)))
      throw new DomainError('VALIDATION_FAILED', 'since must be a timestamp');
    return c.json(await deps.app.getHubSnapshot.execute(c.var.ctx, since));
  });
  v1.post('/hub/batches', async (c) =>
    c.json(await deps.app.ingestHubBatch.execute(c.var.ctx, await body(c, HubBatchCommand))),
  );
  const hubPinLimiter = new RateLimiter(40, 60_000);
  v1.post('/hub/pin-verify', async (c) => {
    if (!hubPinLimiter.allow(c.var.ctx.deviceId ?? 'none'))
      throw new DomainError('RATE_LIMITED', 'Too many PIN attempts. Wait a minute and try again.');
    return c.json(
      await deps.app.verifyPinForHub.execute(c.var.ctx, (await body(c, HubPinVerifyCommand)).pin),
    );
  });
  v1.post('/hub/pin-change', async (c) =>
    c.json(await deps.app.changePinFromHub.execute(c.var.ctx, await body(c, HubPinChangeCommand))),
  );
  v1.post('/admin/branches/:branchId/hub', async (c) =>
    c.json(
      await deps.app.setBranchHub.execute(c.var.ctx, id(c, 'branchId'), await body(c, SetBranchHubCommand)),
    ),
  );
  v1.post('/printers/:printerId/test-print', async (c) =>
    c.json(
      await deps.app.sendTestPrint.execute(c.var.ctx, id(c, 'printerId'), await body(c, TestPrintCommand)),
    ),
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
  v1.get('/orders/:orderId/bill', async (c) =>
    c.json(await deps.app.getBill.execute(c.var.ctx, id(c, 'orderId'))),
  );
  v1.post('/orders/:orderId/bill', async (c) =>
    c.json(
      await deps.app.requestBill.execute(c.var.ctx, id(c, 'orderId'), await body(c, RequestBillCommand)),
    ),
  );
  v1.post('/orders/:orderId/receipt/print', async (c) => {
    op(c, 'print_receipt');
    return c.json(
      await deps.app.printReceipt.execute(c.var.ctx, id(c, 'orderId'), await body(c, PrintReceiptCommand)),
    );
  });

  // Session, menu, dining
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

  // Floor operations
  v1.post('/orders/:orderId/transfer', async (c) =>
    c.json(
      await deps.app.transferOrder.execute(c.var.ctx, id(c, 'orderId'), await body(c, TransferOrderCommand)),
    ),
  );
  v1.post('/orders/:orderId/merge', async (c) =>
    c.json(
      await deps.app.mergeOrders.execute(
        c.var.ctx,
        id(c, 'orderId'),
        (await body(c, MergeOrderCommand)).sourceOrderId,
      ),
    ),
  );
  v1.post('/orders/:orderId/priority', async (c) =>
    c.json(
      await deps.app.setOrderPriority.execute(
        c.var.ctx,
        id(c, 'orderId'),
        (await body(c, OrderPriorityCommand)).rush,
      ),
    ),
  );

  // Activity: the audit history for owners and managers.
  v1.get('/activity', async (c) => {
    const category = c.req.query('category');
    const before = Number(c.req.query('before'));
    return c.json(
      await deps.app.listActivity.execute(c.var.ctx, {
        category: ACTIVITY_CATEGORIES.includes(category as ActivityCategory)
          ? (category as ActivityCategory)
          : null,
        search: c.req.query('q') ?? null,
        before: Number.isSafeInteger(before) && before > 0 ? before : null,
      }),
    );
  });

  // Product photos: the raw image is the request body (the browser resizes it first).
  v1.post('/products/:productId/image', async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > 2 * 1024 * 1024)
      throw new DomainError('VALIDATION_FAILED', 'Choose a photo smaller than 2 MB');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json(await deps.app.setProductImage.execute(c.var.ctx, id(c, 'productId'), bytes));
  });
  v1.post('/products/:productId/image/thumb', async (c) => {
    if (Number(c.req.header('content-length') ?? 0) > 512 * 1024)
      throw new DomainError('VALIDATION_FAILED', 'The thumbnail must be smaller than 512 KB');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json(await deps.app.setProductImageThumb.execute(c.var.ctx, id(c, 'productId'), bytes));
  });
  v1.delete('/products/:productId/image', async (c) =>
    c.json(await deps.app.removeProductImage.execute(c.var.ctx, id(c, 'productId'))),
  );

  v1.post('/admin/devices/:deviceId/approve-pairing', async (c) =>
    c.json(
      await deps.app.approveDevicePairing.execute(
        c.var.ctx,
        id(c, 'deviceId'),
        (await body(c, ApprovePairingCommand)).code,
      ),
    ),
  );

  // Pricing: automatic promotions and manager discounts
  v1.get('/promotions', async (c) => c.json(await deps.app.listPromotions.execute(c.var.ctx)));
  v1.post('/promotions/preview', async (c) =>
    c.json(await deps.app.previewPromotion.execute(c.var.ctx, await body(c, SavePromotionCommand))),
  );
  v1.post('/promotions', async (c) =>
    c.json(await deps.app.savePromotion.execute(c.var.ctx, await body(c, SavePromotionCommand))),
  );
  v1.post('/promotions/:promotionId/status', async (c) => {
    const cmd = await body(c, SetPromotionStatusCommand);
    return c.json(
      await deps.app.setPromotionStatus.execute(
        c.var.ctx,
        id(c, 'promotionId'),
        cmd.action,
        cmd.expectedVersion,
      ),
    );
  });
  v1.post('/orders/:orderId/discount', async (c) =>
    c.json(
      await deps.app.applyManualDiscount.execute(
        c.var.ctx,
        id(c, 'orderId'),
        await body(c, ManualDiscountCommand),
      ),
    ),
  );
  v1.delete('/orders/:orderId/discount', async (c) =>
    c.json(await deps.app.removeManualDiscount.execute(c.var.ctx, id(c, 'orderId'))),
  );

  // Staff PINs (sign-in happens on a registered till: the caller is the till's device login)
  const pinLimiter = new RateLimiter(20, 60_000);
  v1.post('/auth/pin', async (c) => {
    if (!pinLimiter.allow(c.var.ctx.deviceId ?? 'none'))
      throw new DomainError('RATE_LIMITED', 'Too many attempts. Wait a minute and try again.');
    const pin = (await body(c, PinSignInCommand)).pin;
    return c.json(
      await (deps.pins ? deps.pins.signIn(c.var.ctx, pin) : deps.app.pinSignIn.execute(c.var.ctx, pin)),
    );
  });
  v1.post('/auth/pin-recovery', async (c) =>
    c.json(await deps.app.requestPinRecovery.execute(c.var.ctx, (await body(c, PinRecoveryCommand)).email)),
  );
  v1.post('/me/personal-device', async (c) =>
    c.json(await deps.app.registerPersonalDevice.execute(c.var.ctx)),
  );
  v1.post('/me/pin', async (c) =>
    c.json(
      await (
        deps.pins ?? { changeOwnPin: deps.app.changeOwnPin.execute.bind(deps.app.changeOwnPin) }
      ).changeOwnPin(c.var.ctx, await body(c, ChangePinCommand)),
    ),
  );
  v1.post('/admin/staff/:staffId/pin', async (c) =>
    c.json(
      await deps.app.assignStaffPin.execute(
        c.var.ctx,
        id(c, 'staffId'),
        (await body(c, AssignPinCommand)).pin,
      ),
    ),
  );

  // Restaurant operations: dashboard and expediter board
  v1.get('/branches/:branchId/dashboard', async (c) =>
    c.json(await deps.app.getDashboard.execute(c.var.ctx, id(c, 'branchId'))),
  );
  v1.get('/branches/:branchId/reports/sales', async (c) =>
    c.json(
      await deps.app.getSalesReport.execute(
        c.var.ctx,
        id(c, 'branchId'),
        c.req.query('from') ?? '',
        c.req.query('to') ?? '',
      ),
    ),
  );
  // Reports: every report is computed once (application layer); the screen gets JSON and the
  // exports render the same view as PDF, Excel or CSV. Exports are audited.
  const reportQuery = (c: Context<Env>): ReportQuery => {
    const parsed = ReportQuery.safeParse({
      ...Object.fromEntries(Object.entries(c.req.query()).filter(([, v]) => v !== '')),
      branchId: id(c, 'branchId'),
    });
    if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'Check the report filters');
    return parsed.data;
  };
  const reportKind = (c: Context<Env>): ReportKind => {
    const kind = c.req.param('kind') as ReportKind;
    if (!REPORT_KINDS.includes(kind)) throw new DomainError('NOT_FOUND', 'Not found');
    return kind;
  };
  const exportFormat = (c: Context<Env>): ExportFormat => {
    const format = c.req.query('format') as ExportFormat;
    if (!EXPORT_FORMATS.includes(format))
      throw new DomainError('VALIDATION_FAILED', 'Choose PDF, Excel or CSV');
    return format;
  };
  const download = async (c: Context<Env>, view: ReportView, format: ExportFormat) => {
    const file = await renderReport(view, format);
    return c.body(file.bytes as Uint8Array<ArrayBuffer>, 200, {
      'content-type': file.contentType,
      'content-disposition': `attachment; filename="${file.fileName}"`,
      'cache-control': 'no-store',
    });
  };
  v1.get('/branches/:branchId/reports/options', async (c) =>
    c.json(await deps.app.getReportFilterOptions.execute(c.var.ctx, id(c, 'branchId'))),
  );
  v1.get('/branches/:branchId/reports/:kind/export', async (c) => {
    op(c, 'export_report');
    const format = exportFormat(c);
    return download(
      c,
      await deps.app.exportReport.execute(c.var.ctx, reportKind(c), format, reportQuery(c)),
      format,
    );
  });
  v1.get('/branches/:branchId/reports/:kind', async (c) =>
    c.json(await deps.app.getReport.execute(c.var.ctx, reportKind(c), reportQuery(c))),
  );

  // Cash registers
  v1.get('/branches/:branchId/registers/current', async (c) =>
    c.json({ register: await deps.app.getCurrentRegister.execute(c.var.ctx, id(c, 'branchId')) }),
  );
  v1.get('/branches/:branchId/registers', async (c) =>
    c.json(
      await deps.app.listRegisters.execute(c.var.ctx, id(c, 'branchId'), {
        from: c.req.query('from') || null,
        to: c.req.query('to') || null,
      }),
    ),
  );
  v1.post('/registers/open', async (c) => {
    op(c, 'open_register');
    return c.json(await deps.app.openRegister.execute(c.var.ctx, await body(c, OpenRegisterCommand)));
  });
  v1.get('/registers/:sessionId', async (c) =>
    c.json(await deps.app.getRegister.execute(c.var.ctx, id(c, 'sessionId'))),
  );
  v1.post('/registers/:sessionId/close', async (c) => {
    op(c, 'close_register');
    return c.json(
      await deps.app.closeRegister.execute(
        c.var.ctx,
        id(c, 'sessionId'),
        await body(c, CloseRegisterCommand),
      ),
    );
  });
  v1.post('/registers/:sessionId/reopen', async (c) =>
    c.json(
      await deps.app.reopenRegister.execute(
        c.var.ctx,
        id(c, 'sessionId'),
        await body(c, ReopenRegisterCommand),
      ),
    ),
  );
  v1.get('/registers/:sessionId/report', async (c) => {
    const sessionId = id(c, 'sessionId');
    if (!c.req.query('format'))
      return c.json(await deps.app.getRegisterClosingReport.execute(c.var.ctx, sessionId));
    op(c, 'export_report');
    const format = exportFormat(c);
    const register = await deps.app.getRegister.execute(c.var.ctx, sessionId);
    return download(
      c,
      await deps.app.exportReport.execute(c.var.ctx, 'register_closing', format, {
        branchId: register.branchId,
        sessionId,
      }),
      format,
    );
  });

  // Customers (private: see docs/CUSTOMERS.md)
  v1.get('/customers', async (c) => {
    const offset = Number(c.req.query('offset'));
    return c.json(
      await deps.app.listCustomers.execute(c.var.ctx, {
        search: c.req.query('q') ?? null,
        offset: Number.isSafeInteger(offset) && offset > 0 ? offset : 0,
      }),
    );
  });
  v1.get('/customers/lookup', async (c) =>
    c.json(await deps.app.lookupCustomer.execute(c.var.ctx, c.req.query('q') ?? '')),
  );
  v1.get('/customers/:customerId', async (c) =>
    c.json(await deps.app.getCustomer.execute(c.var.ctx, id(c, 'customerId'))),
  );
  v1.post('/customers', async (c) => {
    op(c, 'save_customer');
    return c.json(await deps.app.createCustomer.execute(c.var.ctx, await body(c, CreateCustomerCommand)));
  });
  v1.post('/customers/:customerId', async (c) => {
    op(c, 'save_customer');
    return c.json(
      await deps.app.updateCustomer.execute(
        c.var.ctx,
        id(c, 'customerId'),
        await body(c, UpdateCustomerCommand),
      ),
    );
  });
  v1.post('/customers/:customerId/merge', async (c) =>
    c.json(
      await deps.app.mergeCustomer.execute(
        c.var.ctx,
        id(c, 'customerId'),
        await body(c, MergeCustomerCommand),
      ),
    ),
  );
  v1.post('/orders/:orderId/customer', async (c) =>
    c.json(
      await deps.app.setOrderCustomer.execute(
        c.var.ctx,
        id(c, 'orderId'),
        await body(c, SetOrderCustomerCommand),
      ),
    ),
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
