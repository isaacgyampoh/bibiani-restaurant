import { randomUUID } from 'node:crypto';
import type { AuthDirectory, Clock, ImageStore, LogFields, Logger } from '@rp/application';
import { type Application, createApplication, type Principal, type RequestContext } from '@rp/application';
import { DomainError, ROLE_TEMPLATES } from '@rp/domain';
import {
  cryptoSecrets,
  type Database,
  HmacPinHasher,
  PgIdentityRegistry,
  PgPrincipalResolver,
  PgUnitOfWork,
  type RepositoryDecorator,
  randomIds,
  SupabaseAuthDirectory,
  sha256Fingerprinter,
} from '@rp/infrastructure';
import { HOSTED } from './database';

/**
 * A restaurant configured the way an owner would configure it through admin
 * screens: stations, categories, routing rules, printers and KDS screens are
 * all data. Used by integration tests only; never loaded into a real database.
 */
export interface RestaurantFixture {
  restaurantId: string;
  branchId: string;
  areas: { hall: string; takeaway: string };
  tables: Record<string, string>;
  stations: { kitchen: string; grill: string; pastry: string; drinks: string };
  printers: {
    kitchen: string;
    grill: string;
    pastry: string;
    drinks: string;
    pastry2: string;
    backup: string;
    receipt: string;
  };
  kds: { kitchen: string; grill: string; pastry: string; drinks: string };
  devices: { agent: string; pos: string; display: string };
  authUsers: {
    manager: string;
    cashier: string;
    waiter: string;
    agent: string;
    display: string;
    kitchenKds: string;
    pastryKds: string;
  };
  products: {
    jollof: string;
    chicken: string;
    meatPie: string;
    coke: string;
    birthdayCake: string;
    sandwich: string;
  };
  modifiers: { noPepper: string; extraPepper: string; extraChicken: string };
  taxRateId: string;
}

/** Email/password for users created on hosted runs (so realtime tests can sign in as them). */
export const fixtureCredentials = new Map<string, { email: string; password: string }>();

let directory: SupabaseAuthDirectory | null = null;
function authDirectory(): SupabaseAuthDirectory {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_ANON_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !SUPABASE_ANON_KEY) {
    throw new Error('Hosted tests need SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_ANON_KEY in .env');
  }
  directory ??= new SupabaseAuthDirectory(SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_ANON_KEY);
  return directory;
}

async function authUser(db: Database): Promise<string> {
  if (HOSTED) {
    // Real Supabase Auth user: exactly how staff and devices exist in production.
    const email = `test-${randomUUID().slice(0, 12)}@fixtures.example.com`;
    const password = `${randomUUID()}${randomUUID()}`;
    const { id } = await authDirectory().createUser({ email, password, metadata: { fixture: true } });
    fixtureCredentials.set(id, { email, password });
    return id;
  }
  const id = randomUUID();
  await db.query('insert into auth.users (id) values ($1)', [id]);
  return id;
}

export async function seedRestaurant(
  db: Database,
  options: { slug: string; name?: string; orderNumberStart?: number },
): Promise<RestaurantFixture> {
  const q = (text: string, params: unknown[] = []) => db.query<{ id: string }>(text, params);
  const one = async (text: string, params: unknown[] = []) => (await q(text, params))[0]!.id;

  // Unique per run so suites can run repeatedly against a shared (hosted DEV) database.
  const slug = `${options.slug}-${randomUUID().slice(0, 8)}`;
  const restaurantId = await one(`insert into restaurants (name, slug) values ($1, $2) returning id`, [
    options.name ?? options.slug,
    `test-${slug}`,
  ]);
  const branchId = await one(
    `insert into branches (restaurant_id, name, code, order_number_start) values ($1, 'Main', 'MAIN', $2) returning id`,
    [restaurantId, options.orderNumberStart ?? 5001],
  );

  // Roles & staff ------------------------------------------------------------
  const role = async (name: string, perms: readonly string[]) => {
    const id = await one(
      `insert into roles (restaurant_id, name, is_system) values ($1, $2, true) returning id`,
      [restaurantId, name],
    );
    for (const p of perms) {
      await q(`insert into role_permissions (restaurant_id, role_id, permission_code) values ($1, $2, $3)`, [
        restaurantId,
        id,
        p,
      ]);
    }
    return id;
  };
  // Same role templates every real restaurant starts with.
  const managerRole = await role('Owner', ROLE_TEMPLATES.Owner!);
  const cashierRole = await role('Cashier', ROLE_TEMPLATES.Cashier!);
  const waiterRole = await role('Waiter', ROLE_TEMPLATES.Waiter!);

  const staffMember = async (name: string, roleId: string, scope: string | null = branchId) => {
    const userId = await authUser(db);
    const staffId = await one(
      `insert into staff (restaurant_id, user_id, display_name) values ($1, $2, $3) returning id`,
      [restaurantId, userId, name],
    );
    await q(`insert into staff_roles (restaurant_id, staff_id, role_id, branch_id) values ($1, $2, $3, $4)`, [
      restaurantId,
      staffId,
      roleId,
      scope,
    ]);
    return userId;
  };
  // Owners are restaurant-wide (all branches); floor staff are scoped to their branch.
  const manager = await staffMember('Ama Owner', managerRole, null);
  const cashier = await staffMember('Kofi Cashier', cashierRole);
  const waiter = await staffMember('Esi Waiter', waiterRole);

  // Areas & tables -----------------------------------------------------------
  const hall = await one(
    `insert into operational_areas (restaurant_id, branch_id, name, channel, requires_table) values ($1, $2, 'Hall', 'dine_in', true) returning id`,
    [restaurantId, branchId],
  );
  const takeaway = await one(
    `insert into operational_areas (restaurant_id, branch_id, name, channel) values ($1, $2, 'Takeaway', 'takeaway') returning id`,
    [restaurantId, branchId],
  );
  const tables: Record<string, string> = {};
  for (const label of ['1', '2', '12']) {
    tables[label] = await one(
      `insert into dining_tables (restaurant_id, branch_id, area_id, label) values ($1, $2, $3, $4) returning id`,
      [restaurantId, branchId, hall, label],
    );
  }

  // Stations -----------------------------------------------------------------
  const station = (name: string, code: string, order: number) =>
    one(
      `insert into stations (restaurant_id, branch_id, name, code, sort_order, target_prep_seconds) values ($1, $2, $3, $4, $5, 900) returning id`,
      [restaurantId, branchId, name, code, order],
    );
  const stations = {
    kitchen: await station('Main Kitchen', 'KIT', 1),
    grill: await station('Grill', 'GRL', 2),
    pastry: await station('Pastry', 'PAS', 3),
    drinks: await station('Drinks', 'DRK', 4),
  };

  // Devices ------------------------------------------------------------------
  const device = async (kind: string, name: string, stationId: string | null, authUserId: string | null) =>
    one(
      `insert into devices (restaurant_id, branch_id, kind, name, station_id, auth_user_id) values ($1, $2, $3, $4, $5, $6) returning id`,
      [restaurantId, branchId, kind, name, stationId, authUserId],
    );
  const agentUser = await authUser(db);
  const displayUser = await authUser(db);
  const kitchenKdsUser = await authUser(db);
  const pastryKdsUser = await authUser(db);
  const agent = await device('print_agent', 'AGENT-01', null, agentUser);
  const pos = await device('pos', 'POS-01', null, null);
  const display = await device('customer_display', 'CUSTOMER-DISPLAY-01', null, displayUser);

  const printer = async (name: string, address: string) => {
    const id = await device('printer', name, null, null);
    await q(
      `insert into printers (device_id, restaurant_id, connection, address, agent_device_id) values ($1, $2, 'network_escpos', $3, $4)`,
      [id, restaurantId, address, agent],
    );
    return id;
  };
  const printers = {
    kitchen: await printer('KITCHEN-PRINTER-01', '192.168.1.51:9100'),
    grill: await printer('GRILL-PRINTER-01', '192.168.1.52:9100'),
    pastry: await printer('PASTRY-PRINTER-01', '192.168.1.53:9100'),
    drinks: await printer('DRINKS-PRINTER-01', '192.168.1.54:9100'),
    pastry2: await printer('PASTRY-PRINTER-02', '192.168.1.55:9100'),
    backup: await printer('BACKUP-PRINTER-01', '192.168.1.59:9100'),
  };
  await q('update printers set backup_printer_id = $1 where device_id = $2', [
    printers.backup,
    printers.pastry,
  ]);
  const receiptPrinter = await printer('RECEIPT-PRINTER-01', '192.168.1.60:9100');
  await q('update devices set receipt_printer_id = $1 where id = $2', [receiptPrinter, pos]);

  const kds = {
    kitchen: await device('kds', 'KITCHEN-KDS-01', stations.kitchen, kitchenKdsUser),
    grill: await device('kds', 'GRILL-KDS-01', stations.grill, null),
    pastry: await device('kds', 'PASTRY-KDS-01', stations.pastry, pastryKdsUser),
    drinks: await device('kds', 'DRINKS-KDS-01', stations.drinks, null),
  };
  for (const key of ['kitchen', 'grill', 'pastry', 'drinks'] as const) {
    await q(
      `insert into station_outputs (restaurant_id, station_id, device_id, role) values ($1, $2, $3, 'primary')`,
      [restaurantId, stations[key], printers[key]],
    );
    await q(
      `insert into station_outputs (restaurant_id, station_id, device_id, role) values ($1, $2, $3, 'primary')`,
      [restaurantId, stations[key], kds[key]],
    );
  }

  // Catalog ------------------------------------------------------------------
  const taxRateId = await one(
    `insert into tax_rates (restaurant_id, name, rate_bp, is_inclusive) values ($1, 'Standard tax', 1500, true) returning id`,
    [restaurantId],
  );
  const category = (name: string, parentId: string | null) =>
    one(`insert into categories (restaurant_id, name, parent_id) values ($1, $2, $3) returning id`, [
      restaurantId,
      name,
      parentId,
    ]);
  const food = await category('Food', null);
  const rice = await category('Rice Dishes', food);
  const grills = await category('Grills', food);
  const sandwiches = await category('Sandwiches', food);
  const pastries = await category('Pastries', null);
  const cakes = await category('Cakes', pastries);
  const drinks = await category('Drinks', null);

  const product = async (
    name: string,
    categoryId: string,
    price: number,
    kitchenName: string | null = null,
  ) => {
    const id = await one(
      `insert into products (restaurant_id, category_id, name, kitchen_name, base_price) values ($1, $2, $3, $4, $5) returning id`,
      [restaurantId, categoryId, name, kitchenName, price],
    );
    await q(`insert into product_taxes (restaurant_id, product_id, tax_rate_id) values ($1, $2, $3)`, [
      restaurantId,
      id,
      taxRateId,
    ]);
    return id;
  };
  const products = {
    jollof: await product('Jollof Rice', rice, 4500, 'JOLLOF'),
    chicken: await product('Grilled Chicken', grills, 6000),
    meatPie: await product('Meat Pie', pastries, 1500),
    coke: await product('Coke', drinks, 1000),
    birthdayCake: await product('Birthday Cake', cakes, 25000),
    sandwich: await product('Chicken Sandwich', sandwiches, 3500),
  };

  const spice = await one(
    `insert into modifier_groups (restaurant_id, name, min_select, max_select) values ($1, 'Spice level', 0, 1) returning id`,
    [restaurantId],
  );
  const extras = await one(
    `insert into modifier_groups (restaurant_id, name, min_select, max_select) values ($1, 'Extras', 0, null) returning id`,
    [restaurantId],
  );
  const modifier = (groupId: string, name: string, delta: number) =>
    one(
      `insert into modifiers (restaurant_id, group_id, name, price_delta) values ($1, $2, $3, $4) returning id`,
      [restaurantId, groupId, name, delta],
    );
  const modifiers = {
    noPepper: await modifier(spice, 'NO PEPPER', 0),
    extraPepper: await modifier(spice, 'EXTRA PEPPER', 0),
    extraChicken: await modifier(extras, 'EXTRA CHICKEN', 1000),
  };
  for (const g of [spice, extras]) {
    await q(`insert into product_modifier_groups (restaurant_id, product_id, group_id) values ($1, $2, $3)`, [
      restaurantId,
      products.jollof,
      g,
    ]);
  }

  // Routing: category rules + a product override with an extra printer ------
  const rule = (match: string, productId: string | null, categoryId: string | null, stationId: string) =>
    one(
      `insert into routing_rules (restaurant_id, branch_id, match, product_id, category_id, station_id) values ($1, $2, $3, $4, $5, $6) returning id`,
      [restaurantId, branchId, match, productId, categoryId, stationId],
    );
  await rule('category', null, food, stations.kitchen);
  await rule('category', null, grills, stations.grill);
  await rule('category', null, pastries, stations.pastry);
  await rule('category', null, drinks, stations.drinks);
  await rule('default', null, null, stations.kitchen);
  const cakeRule = await rule('product', products.birthdayCake, null, stations.pastry);
  await q(
    `insert into routing_rule_extra_outputs (restaurant_id, routing_rule_id, device_id) values ($1, $2, $3)`,
    [restaurantId, cakeRule, printers.pastry2],
  );

  return {
    restaurantId,
    branchId,
    areas: { hall, takeaway },
    tables,
    stations,
    printers: { ...printers, receipt: receiptPrinter },
    kds,
    devices: { agent, pos, display },
    authUsers: {
      manager,
      cashier,
      waiter,
      agent: agentUser,
      display: displayUser,
      kitchenKds: kitchenKdsUser,
      pastryKds: pastryKdsUser,
    },
    products,
    modifiers,
    taxRateId,
  };
}

/** Controllable clock for lease/backoff tests. */
/** Product photo storage kept in memory (tests never touch Supabase Storage). */
export class MemoryImageStore implements ImageStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async put(path: string, bytes: Uint8Array, contentType: string) {
    if (this.objects.has(path)) throw new Error('exists');
    this.objects.set(path, { bytes, contentType });
  }
  async remove(path: string) {
    this.objects.delete(path);
  }
  publicUrl(path: string) {
    return `https://storage.test/product-images/${path}`;
  }
}

export class TestClock implements Clock {
  constructor(private current = new Date('2026-09-25T12:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

export class CapturingLogger implements Logger {
  readonly lines: { level: string; event: string; fields: LogFields }[] = [];
  info(event: string, fields: LogFields = {}) {
    this.lines.push({ level: 'info', event, fields });
  }
  warn(event: string, fields: LogFields = {}) {
    this.lines.push({ level: 'warn', event, fields });
  }
  error(event: string, fields: LogFields = {}) {
    this.lines.push({ level: 'error', event, fields });
  }
}

export interface TestApp {
  app: Application;
  clock: TestClock;
  logger: CapturingLogger;
  images: MemoryImageStore;
  resolver: PgPrincipalResolver;
  /** Resolves a real principal through the production resolver (membership tables). */
  as(authUserId: string, deviceId?: string | null): Promise<RequestContext>;
}

export function createTestApp(db: Database, options: { decorate?: RepositoryDecorator } = {}): TestApp {
  const clock = new TestClock();
  const logger = new CapturingLogger();
  const images = new MemoryImageStore();
  const resolver = new PgPrincipalResolver(db);
  const app = createApplication({
    auth: HOSTED ? authDirectory() : new LocalAuthDirectory(db),
    identity: new PgIdentityRegistry(db),
    secrets: cryptoSecrets,
    deviceAccountDomain: 'devices.example.com',
    pinHasher: new HmacPinHasher('test-pepper-0123456789abcdef0123456789abcdef'),
    publicUrl: 'https://app.test',
    images,
    uow: new PgUnitOfWork(db, {
      decorate: options.decorate,
      // Hosted runs execute ~140 ms away from the database (production API is co-located), so
      // transactions hold locks ~100x longer; waits are allowed to be proportionally longer.
      statementTimeoutMs: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 8000),
      lockTimeoutMs: Number(process.env.DB_LOCK_TIMEOUT_MS ?? 4000),
    }),
    clock,
    ids: randomIds,
    fingerprint: sha256Fingerprinter,
    logger,
  });
  return {
    app,
    clock,
    logger,
    images,
    resolver,
    async as(authUserId, deviceId = null) {
      const result = await resolver.resolve(authUserId, null);
      if (!result.ok) throw new Error(`Cannot resolve principal: ${result.reason}`);
      const principal: Principal = result.principal;
      return {
        principal,
        correlationId: randomUUID(),
        deviceId: principal.kind === 'device' ? principal.deviceId : deviceId,
      };
    },
  };
}

/**
 * Stand-in identity provider for local (PGlite) runs only: stores users in the
 * stub auth.users table and returns opaque tokens. Hosted runs use real Supabase Auth.
 */
export class LocalAuthDirectory implements AuthDirectory {
  readonly users = new Map<string, { id: string; password: string }>();
  constructor(private readonly db: Database) {}
  async createUser(input: { email: string; password: string }) {
    if (this.users.has(input.email))
      throw new DomainError('VALIDATION_FAILED', 'An account with this email already exists');
    const id = randomUUID();
    await this.db.query('insert into auth.users (id, email) values ($1, $2)', [id, input.email]);
    this.users.set(input.email, { id, password: input.password });
    return { id };
  }
  async deleteUser(id: string) {
    await this.db.query('delete from auth.users where id = $1', [id]).catch(() => undefined);
    for (const [email, u] of this.users) if (u.id === id) this.users.delete(email);
  }
  async updatePassword(id: string, password: string) {
    for (const u of this.users.values()) if (u.id === id) u.password = password;
  }
  readonly sessions: string[] = [];
  readonly recoveryEmails: { email: string; redirectTo: string }[] = [];
  async createSession(userId: string) {
    this.sessions.push(userId);
    return {
      accessToken: `local.${userId}`,
      refreshToken: randomUUID(),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }
  async sendRecoveryEmail(email: string, redirectTo: string) {
    this.recoveryEmails.push({ email, redirectTo });
  }
  async signIn(email: string, password: string) {
    const u = this.users.get(email);
    if (!u || u.password !== password) throw new DomainError('UNAUTHENTICATED', 'Sign-in failed');
    return {
      accessToken: `local.${u.id}`,
      refreshToken: randomUUID(),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }
}
