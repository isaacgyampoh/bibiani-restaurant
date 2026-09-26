import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createHttpApp } from '@rp/api';
import { createApplication, type ImageStore, type Logger } from '@rp/application';
import { ApiClient } from '@rp/client-core';
import { DomainError } from '@rp/domain';
import {
  getState,
  HttpCloud,
  HubAuthDirectory,
  type HubIdentity,
  HubPinService,
  hubAuthRoutes,
  openLocalDatabase,
  SyncEngine,
} from '@rp/hub';
import {
  cryptoSecrets,
  type Database,
  HmacPinHasher,
  PgIdentityRegistry,
  PgPrincipalResolver,
  PgUnitOfWork,
  randomIds,
  sha256Fingerprinter,
  systemClock,
} from '@rp/infrastructure';
import { NetworkEscPosDriver, PrintAgent, PrintJournal } from '@rp/print-agent';
import { type Context, Hono } from 'hono';

export interface HubConfig {
  /** Where the hub keeps its database, image cache and print journal. */
  dataDir: string;
  migrationsDir: string;
  /** The built web app (apps/web/dist). */
  webDist: string;
  /** The MY FOOD cloud API and Supabase project (public values). */
  cloudApiUrl: string;
  supabaseUrl: string;
  /** Hub-only secrets, created on first start and kept by the desktop app's secret store. */
  secrets: { jwtSecret: string; pinPepper: string };
  /** Access token of the hub's own cloud device login (refreshed by the caller). */
  cloudToken: () => Promise<string>;
  logger: Logger;
  release: string;
  /** Port the hub listens on (for its in-process print agent). */
  port: number;
  /** Test hook: how the hub reaches the cloud API (default: the network). */
  cloudFetch?: typeof fetch;
  /**
   * Whether a request comes from the hub PC itself (the hub window). Default: loopback address.
   * Console actions (approving device pairings) are only allowed from there.
   */
  isConsoleRequest?: (c: Context) => boolean;
  /** Extra facts for the hub window (first-run cloud pairing, addresses for the tills). */
  describe?: () => Record<string, unknown>;
}

const IMAGE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}-[0-9a-f-]{36}(-t)?\.(webp|jpg|png)$/;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Photos come from the cloud and are cached on the hub; they are changed in the back office only. */
class HubImageStore implements ImageStore {
  async put(): Promise<void> {
    throw new DomainError('UNAVAILABLE', 'Change product photos in the MY FOOD back office');
  }
  async remove(): Promise<void> {
    throw new DomainError('UNAVAILABLE', 'Change product photos in the MY FOOD back office');
  }
  publicUrl(path: string): string {
    return `/storage/v1/object/public/product-images/${path}`;
  }
}

export async function createHub(config: HubConfig) {
  mkdirSync(config.dataDir, { recursive: true });
  const { db } = await openLocalDatabase({
    dataDir: join(config.dataDir, 'db'),
    migrationsDir: config.migrationsDir,
  });
  const logger = config.logger;
  const auth = new HubAuthDirectory(db, config.secrets.jwtSecret);
  const pinHasher = new HmacPinHasher(config.secrets.pinPepper);
  const app = createApplication({
    auth,
    identity: new PgIdentityRegistry(db),
    secrets: cryptoSecrets,
    deviceAccountDomain: 'devices.hub.local',
    pinHasher,
    images: new HubImageStore(),
    uow: new PgUnitOfWork(db),
    clock: systemClock,
    ids: randomIds,
    fingerprint: sha256Fingerprinter,
    logger,
  });

  const cloud = new HttpCloud(
    new ApiClient({
      baseUrl: config.cloudApiUrl,
      getAccessToken: config.cloudToken,
      ...(config.cloudFetch ? { fetch: config.cloudFetch } : {}),
    }),
  );
  const engine = new SyncEngine(db, cloud, {
    newId: () => randomIds.uuid(),
    onError: (error) => logger.warn('hub.sync_failed', { error: String(error).slice(0, 300) }),
  });
  await engine.init();
  let connected = false;
  const pins = new HubPinService(db, app, pinHasher, cloud, () => connected);

  const resolver = new PgPrincipalResolver(db);
  const api = createHttpApp({
    app,
    verifier: auth.verifier(),
    resolver,
    logger,
    release: config.release,
    pins,
  });

  const http = new Hono();
  http.use('*', async (c, next) => {
    await next();
    c.header(
      'content-security-policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('x-frame-options', 'DENY');
  });
  http.route('/', hubAuthRoutes(auth));
  http.all('/v1/*', (c) => api.fetch(c.req.raw));
  http.all('/health/*', (c) => api.fetch(c.req.raw));

  // What the hub itself is doing (read by the hub window and the "Offline" banner on the tills).
  http.get('/hub/status', async (c) =>
    c.json({ ...(await engine.status()), release: config.release, ...(config.describe?.() ?? {}) }),
  );

  // Hub console (the hub window on the hub PC only): device pairing approvals with a manager PIN.
  // Managers have no passwords on the hub; being at the hub PC plus a PIN of someone whose role
  // includes device management stands in for the back office's password sign-in. Audited.
  const isConsole =
    config.isConsoleRequest ??
    ((c: Context) => {
      const address = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
        ?.socket?.remoteAddress;
      return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    });
  const consoleOnly = async (c: Context, next: () => Promise<void>) => {
    if (!isConsole(c)) return c.json({ error: { code: 'FORBIDDEN', message: 'Only from the hub PC' } }, 403);
    await next();
  };
  http.use('/hub/console/*', consoleOnly);
  http.get('/hub/console/devices', async (c) => {
    const identity = await getState<HubIdentity>(db, 'identity');
    if (!identity) return c.json({ devices: [] });
    const devices = await db.query(
      `select id, name, kind, is_active as "isActive", auth_user_id is not null as paired
         from devices where branch_id = $1 and kind in ('pos', 'kds', 'customer_display') order by kind, name`,
      [identity.branchId],
    );
    return c.json({ devices });
  });
  http.post('/hub/console/approve-pairing', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      deviceId?: string;
      code?: string;
      managerPin?: string;
    };
    const identity = await getState<HubIdentity>(db, 'identity');
    if (!identity) throw new DomainError('UNAVAILABLE', 'The hub has not synced with MY FOOD yet');
    if (!body.deviceId || !body.code || !body.managerPin)
      throw new DomainError('VALIDATION_FAILED', 'Choose the device and enter the code and your PIN');
    // The PIN is checked by the same use case (and lockouts) the cloud uses, acting as the hub device.
    const hubCtx = await deviceContext(db, resolver, identity.hubDeviceId, 'hub');
    await pins.learn(identity.restaurantId, body.managerPin);
    const { staffId } = await app.verifyPinForHub.execute(hubCtx, body.managerPin);
    const [staff] = await db.query<{ user_id: string | null }>('select user_id from staff where id = $1', [
      staffId,
    ]);
    const resolved = staff?.user_id ? await resolver.resolve(staff.user_id, identity.restaurantId) : null;
    if (!resolved?.ok) throw new DomainError('FORBIDDEN', 'This staff member cannot approve devices');
    await app.approveDevicePairing.execute(
      {
        principal: resolved.principal,
        correlationId: randomIds.uuid(),
        deviceId: identity.hubDeviceId,
        authMethod: 'password',
      },
      body.deviceId,
      body.code,
    );
    return c.json({ ok: true });
  });
  http.onError((error, c) => {
    const e = error as { code?: string; message?: string };
    const status = e.code === 'FORBIDDEN' ? 403 : e.code === 'RATE_LIMITED' ? 429 : e.code ? 400 : 500;
    if (status === 500) logger.error('hub.error', { error: String(error).slice(0, 300) });
    return c.json(
      { error: { code: e.code ?? 'INTERNAL', message: status === 500 ? 'Something went wrong' : e.message } },
      status,
    );
  });

  // Product photos: cached from the cloud, served locally so menus keep their pictures offline.
  const imageDir = join(config.dataDir, 'images');
  http.get('/storage/v1/object/public/product-images/*', async (c) => {
    const path = c.req.path.replace('/storage/v1/object/public/product-images/', '');
    if (!IMAGE_PATH.test(path)) return c.notFound();
    const file = join(imageDir, path);
    if (!existsSync(file)) {
      try {
        const res = await fetch(`${config.supabaseUrl}/storage/v1/object/public/product-images/${path}`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return c.notFound();
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      } catch {
        return c.notFound();
      }
    }
    return c.body(readFileSync(file), 200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=86400',
    });
  });

  // The web app (same build as the cloud), marked as served by the hub.
  const webRoot = resolve(config.webDist);
  const indexHtml = () =>
    readFileSync(join(webRoot, 'index.html'), 'utf8').replace(
      '<head>',
      '<head>\n    <meta name="myfood-hub" content="1">',
    );
  http.get('*', (c) => {
    const requested = normalize(join(webRoot, decodeURIComponent(c.req.path)));
    if (requested.startsWith(webRoot) && extname(requested) && existsSync(requested)) {
      return c.body(readFileSync(requested), 200, {
        'content-type': TYPES[extname(requested)] ?? 'application/octet-stream',
        'cache-control': requested.includes(`${webRoot}/assets/`)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      });
    }
    return c.html(indexHtml(), 200, { 'cache-control': 'no-cache' });
  });

  // The print agent runs inside the hub, printing to network printers on the restaurant LAN.
  let agent: PrintAgent | null = null;
  const startPrintAgent = async () => {
    const identity = await getState<HubIdentity>(db, 'identity');
    if (!identity || agent) return;
    const agentUser = await localPrintAgentLogin(db, identity.branchId);
    if (!agentUser) return; // no print agent device set up for this branch yet
    let session: { token: string; expiresAt: number } | null = null;
    agent = new PrintAgent({
      api: new ApiClient({
        baseUrl: `http://127.0.0.1:${config.port}`,
        getAccessToken: async () => {
          if (!session || session.expiresAt - 60 < Date.now() / 1000) {
            const s = await auth.createSession(agentUser);
            session = { token: s.accessToken, expiresAt: s.expiresAt };
          }
          return session.token;
        },
      }),
      driverFor: (printer) => {
        if (printer.connection !== 'network_escpos' || !printer.address)
          throw new Error(`Printer ${printer.name}: only network printers are supported by the hub`);
        return new NetworkEscPosDriver(printer.address);
      },
      journal: new PrintJournal(join(config.dataDir, 'print-journal.jsonl')),
      logger,
      appVersion: config.release,
    });
    agent.start();
    logger.info('hub.print_agent_started', { branchId: identity.branchId });
  };

  return {
    fetch: http.fetch,
    db,
    engine,
    async start() {
      const tick = async () => {
        await engine.syncOnce();
        const status = await engine.status();
        connected = status.cloud === 'connected';
        if (connected && status.identity)
          await cloud
            .report({
              appVersion: config.release,
              printers: [],
              hub: {
                pendingChanges: status.outbox.pending,
                conflicts: status.outbox.conflicts,
                oldestPendingAt: status.outbox.oldestPendingAt,
                devices: await localDeviceHealth(db, status.identity.branchId),
              },
            })
            .catch((e) => logger.warn('hub.report_failed', { error: String(e).slice(0, 200) }));
        await startPrintAgent().catch((e) => logger.warn('hub.print_agent_failed', { error: String(e) }));
      };
      await tick();
      const timer = setInterval(() => void tick(), 15_000);
      return () => {
        clearInterval(timer);
        agent?.stop();
      };
    },
  };
}

/** What the hub sees of its branch's devices, for the back office health centre. */
async function localDeviceHealth(db: Database, branchId: string) {
  const rows = await db.query<{
    id: string;
    kind: string;
    last_heartbeat_at: string | null;
    last_error: string | null;
    last_status_at: string | null;
    unprinted: number;
  }>(
    `select d.id, d.kind, d.last_heartbeat_at, pr.last_error, pr.last_status_at,
            (select count(*) from print_jobs j where j.printer_id = d.id and j.status in ('failed', 'dead'))::int as unprinted
       from devices d left join printers pr on pr.device_id = d.id
      where d.branch_id = $1 and d.kind <> 'hub' and d.is_active`,
    [branchId],
  );
  const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
  return rows.map((r) => ({
    deviceId: r.id,
    lastSeenAt: r.kind === 'printer' ? iso(r.last_status_at) : iso(r.last_heartbeat_at),
    printerError: r.kind === 'printer' ? (r.last_error?.slice(0, 300) ?? null) : null,
    unprintedJobs: r.unprinted,
  }));
}

/** A request context for one of the branch's own devices acting on the hub (hub-local login). */
async function deviceContext(db: Database, resolver: PgPrincipalResolver, deviceId: string, kind: string) {
  const [device] = await db.query<{ auth_user_id: string | null; kind: string }>(
    'select auth_user_id, kind from devices where id = $1',
    [deviceId],
  );
  if (!device || device.kind !== kind) throw new DomainError('UNAVAILABLE', 'The hub is not set up yet');
  let userId = device.auth_user_id;
  if (!userId) {
    userId = randomIds.uuid();
    await db.transaction(async (sql) => {
      await sql.query('insert into auth.users (id) values ($1)', [userId]);
      await sql.query('update devices set auth_user_id = $2 where id = $1', [deviceId, userId]);
    });
  }
  const resolved = await resolver.resolve(userId, null);
  if (!resolved.ok) throw new DomainError('UNAVAILABLE', 'The hub is not set up yet');
  return { principal: resolved.principal, correlationId: randomIds.uuid(), deviceId };
}

/**
 * The branch's print agent device acts through the hub: it gets a hub-local login (never a cloud one).
 * Returns that login's user id, or null when the branch has no active print agent device.
 */
async function localPrintAgentLogin(db: Database, branchId: string): Promise<string | null> {
  const [device] = await db.query<{ id: string; auth_user_id: string | null }>(
    `select id, auth_user_id from devices
      where branch_id = $1 and kind = 'print_agent' and is_active order by name limit 1`,
    [branchId],
  );
  if (!device) return null;
  if (device.auth_user_id) return device.auth_user_id;
  const userId = randomIds.uuid();
  await db.transaction(async (sql) => {
    await sql.query('insert into auth.users (id) values ($1)', [userId]);
    await sql.query('update devices set auth_user_id = $2 where id = $1', [device.id, userId]);
  });
  return userId;
}
