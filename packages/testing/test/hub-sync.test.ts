import { randomUUID } from 'node:crypto';
import type { HubBatchCommand } from '@rp/contracts';
import { type CloudPort, openLocalDatabase, SyncEngine } from '@rp/hub';
import type { Database } from '@rp/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPgliteInstance,
  createTestApp,
  createTestDatabase,
  MIGRATIONS_DIR,
  type RestaurantFixture,
  seedRestaurant,
  type TestApp,
  type TestDatabase,
} from '../src';
import { line, uuid } from './helpers';

/**
 * The in-store hub scenario (docs/OFFLINE-ARCHITECTURE.md): two separate databases, the cloud and
 * the hub. The hub runs the SAME application layer on its own database, keeps working while the
 * cloud is unreachable, and uploads its floor records exactly once when the connection returns.
 */
describe('in-store hub: offline operation and sync', () => {
  let cloudDb: TestDatabase;
  let hubDb: Database;
  let f: RestaurantFixture;
  let cloud: TestApp;
  let hub: TestApp;
  let engine: SyncEngine;
  let hubUser: string;
  let hubDeviceId: string;
  let online = true;
  const uploads: HubBatchCommand[] = [];
  let rice: string;

  const count = (db: Database, sql: string, params: unknown[] = []) =>
    db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params).then((r) => r[0]!.n);

  beforeAll(async () => {
    cloudDb = await createTestDatabase();
    f = await seedRestaurant(cloudDb, { slug: 'hub-sync' });
    cloud = createTestApp(cloudDb);

    // A hub device in the cloud, paired (has a login) and attached to the branch.
    hubUser = randomUUID();
    await cloudDb.query('insert into auth.users (id) values ($1)', [hubUser]);
    [{ id: hubDeviceId }] = (await cloudDb.query<{ id: string }>(
      `insert into devices (restaurant_id, branch_id, kind, name, auth_user_id) values ($1, $2, 'hub', 'HUB-01', $3) returning id`,
      [f.restaurantId, f.branchId, hubUser],
    )) as [{ id: string }];
    const manager = await cloud.as(f.authUsers.manager);
    await cloud.app.setBranchHub.execute(manager, f.branchId, { hubDeviceId });

    // Stock in the back office: rice with a recipe on jollof, 10 kg delivered.
    ({ id: rice } = await cloud.app.saveInventoryItem.execute(manager, {
      branchId: f.branchId,
      name: 'Rice',
      unit: 'kg',
      minQuantity: 1,
      unitCost: 2000,
      isActive: true,
    }));
    await cloud.app.saveRecipe.execute(manager, f.products.jollof, {
      components: [{ itemId: rice, quantity: 0.25 }],
    });
    await cloud.app.recordStockMovement.execute(manager, {
      movementId: uuid(),
      itemId: rice,
      kind: 'receive',
      quantity: 10,
    });

    // The hub: its own database, same migrations, same application layer.
    const local = await openLocalDatabase({
      dataDir: null,
      migrationsDir: MIGRATIONS_DIR,
      pglite: await createPgliteInstance(),
    });
    hubDb = local.db;
    hub = createTestApp(hubDb);
    const port: CloudPort = {
      snapshot: async (since) => {
        if (!online) throw new Error('getaddrinfo ENOTFOUND api (no internet)');
        return cloud.app.getHubSnapshot.execute(await cloud.as(hubUser), since);
      },
      upload: async (batch) => {
        if (!online) throw new Error('getaddrinfo ENOTFOUND api (no internet)');
        uploads.push(batch);
        return cloud.app.ingestHubBatch.execute(await cloud.as(hubUser), batch);
      },
    };
    engine = new SyncEngine(hubDb, port, {
      newId: randomUUID,
      batchSize: 25,
      onError: (e) => {
        if (online) console.error('SYNC', e);
      },
    });
    await engine.init();
  });
  afterAll(async () => {
    await hubDb?.close();
    await cloudDb?.close();
  });

  const stock = async (db: Database) =>
    Number(
      (
        await db.query<{ q: string }>('select quantity::text as q from inventory_items where id = $1', [rice])
      )[0]!.q,
    );

  const sellOnHub = async (productId: string, qty: number) => {
    const cashier = await hub.as(f.authUsers.cashier, f.devices.pos);
    const order = await hub.app.submitOrder.execute(cashier, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(productId, qty)],
      send: { submissionId: uuid() },
    });
    await hub.app.recordPayment.execute(cashier, order.id, {
      paymentId: uuid(),
      method: 'cash',
      tendered: 100000,
    });
    return order;
  };

  it('first sync gives the hub the branch configuration and stock, never the cloud PIN digests', async () => {
    const report = await engine.syncOnce();
    expect(report.snapshotApplied).toBe(true);
    expect(await count(hubDb, 'products')).toBe(
      await count(cloudDb, 'products where restaurant_id = $1', [f.restaurantId]),
    );
    expect(await count(hubDb, 'staff where pin_lookup is not null')).toBe(0);
    expect(await stock(hubDb)).toBe(10);
    const status = await engine.status();
    expect(status.cloud).toBe('connected');
    expect(status.identity).toMatchObject({ branchId: f.branchId, hubDeviceId, attached: true });
  });

  it('while the branch has a hub, the cloud refuses floor writes for it', async () => {
    const cashier = await cloud.as(f.authUsers.cashier, f.devices.pos);
    await expect(
      cloud.app.submitOrder.execute(cashier, {
        orderId: uuid(),
        branchId: f.branchId,
        areaId: f.areas.takeaway,
        items: [line(f.products.coke, 1)],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('internet down: orders, kitchen tickets, cash and stock keep working on the hub; nothing is lost', async () => {
    online = false;
    const a = await sellOnHub(f.products.jollof, 2); // 0.5 kg rice
    const b = await sellOnHub(f.products.chicken, 1);
    expect(a.orderNumber).not.toBe(b.orderNumber);
    expect(a.tickets.length).toBeGreaterThan(0);
    expect(await stock(hubDb)).toBe(9.5);

    const report = await engine.syncOnce();
    expect(report.uploaded).toBe(0);
    const status = await engine.status();
    expect(status.cloud).toBe('offline');
    expect(status.outbox.pending).toBeGreaterThan(0);
    expect(status.outbox.retrying).toBeGreaterThan(0);
    expect(await count(cloudDb, 'orders where id = any($1)', [[a.id, b.id]])).toBe(0);
  });

  it('price changed in the back office while offline: the sale keeps the price actually charged', async () => {
    const before = (
      await cloudDb.query<{ p: string }>('select base_price::text as p from products where id = $1', [
        f.products.jollof,
      ])
    )[0]!.p;
    await cloudDb.query('update products set base_price = base_price + 500 where id = $1', [
      f.products.jollof,
    ]);
    online = true;
    await engine.syncOnce();
    const [item] = await cloudDb.query<{ unit_price: string }>(
      `select oi.unit_price::text from order_items oi join products p on p.id = oi.product_id
        where p.id = $1 order by oi.created_at desc limit 1`,
      [f.products.jollof],
    );
    expect(item!.unit_price).toBe(before);
    // New orders on the hub now use the new price.
    const c = await sellOnHub(f.products.jollof, 1);
    const [newItem] = await hubDb.query<{ unit_price: string }>(
      'select unit_price::text from order_items where order_id = $1',
      [c.id],
    );
    expect(Number(newItem!.unit_price)).toBe(Number(before) + 500);
  });

  it('internet back: every order, payment, ticket, stock movement and audit event reaches the cloud exactly once', async () => {
    await engine.syncOnce();
    const status = await engine.status();
    expect(status.outbox.pending).toBe(0);
    expect(status.outbox.conflicts).toBe(0);

    const hubOrders = await hubDb.query<{ id: string }>('select id from orders');
    const ids = hubOrders.map((o) => o.id);
    expect(await count(cloudDb, 'orders where id = any($1)', [ids])).toBe(ids.length);
    for (const table of ['order_items', 'payments', 'production_tickets']) {
      expect(await count(cloudDb, `${table} where order_id = any($1)`, [ids])).toBe(
        await count(hubDb, `${table} where order_id = any($1)`, [ids]),
      );
    }
    expect(await count(cloudDb, `audit_logs where origin_id is not null`)).toBe(
      await count(hubDb, 'audit_logs'),
    );

    // Stock: 10 kg delivered, 3 jollof sold (0.75 kg): both sides agree, deducted once.
    expect(await stock(hubDb)).toBe(9.25);
    expect(await stock(cloudDb)).toBe(9.25);

    // Cloud reports see the hub's sales.
    const paid = await count(cloudDb, `payments where order_id = any($1) and method = 'cash'`, [ids]);
    expect(paid).toBe(3);
  });

  it('uploading the same batches again changes nothing (duplicate delivery after a lost acknowledgement)', async () => {
    const snapshot = async () => ({
      orders: await count(cloudDb, 'orders'),
      items: await count(cloudDb, 'order_items'),
      payments: await count(cloudDb, 'payments'),
      movements: await count(cloudDb, 'stock_movements'),
      audit: await count(cloudDb, 'audit_logs'),
      events: await count(cloudDb, 'order_events'),
      stock: await stock(cloudDb),
    });
    const before = await snapshot();
    const ctx = await cloud.as(hubUser);
    for (const batch of uploads) {
      await cloud.app.ingestHubBatch.execute(ctx, batch); // same batch id: replay
      await cloud.app.ingestHubBatch.execute(ctx, { ...batch, batchId: uuid() }); // new id, same records
    }
    expect(await snapshot()).toEqual(before);
  });

  it('back-office stock changes reach the hub once; the hub’s own sales are not applied twice', async () => {
    const manager = await cloud.as(f.authUsers.manager);
    await cloud.app.recordStockMovement.execute(manager, {
      movementId: uuid(),
      itemId: rice,
      kind: 'waste',
      quantity: 0.25,
      reason: 'Spilled',
    });
    await engine.syncOnce();
    await engine.syncOnce();
    expect(await stock(cloudDb)).toBe(9);
    expect(await stock(hubDb)).toBe(9);
  });

  it('two tills offline at the same time: distinct order numbers, all synced once on reconnect', async () => {
    const [{ id: pos2 }] = (await cloudDb.query<{ id: string }>(
      `insert into devices (restaurant_id, branch_id, kind, name) values ($1, $2, 'pos', 'POS-02') returning id`,
      [f.restaurantId, f.branchId],
    )) as [{ id: string }];
    await engine.syncOnce();
    online = false;
    const till = async (deviceId: string) => {
      const cashier = await hub.as(f.authUsers.cashier, deviceId);
      return hub.app.submitOrder.execute(cashier, {
        orderId: uuid(),
        branchId: f.branchId,
        areaId: f.areas.takeaway,
        items: [line(f.products.coke, 1)],
        send: { submissionId: uuid() },
      });
    };
    const orders = await Promise.all([till(f.devices.pos), till(pos2), till(f.devices.pos), till(pos2)]);
    expect(new Set(orders.map((o) => o.orderNumber)).size).toBe(4);
    online = true;
    await engine.syncOnce();
    const ids = orders.map((o) => o.id);
    expect(await count(cloudDb, 'orders where id = any($1)', [ids])).toBe(4);
    expect(
      await count(cloudDb, 'order_submissions where order_id = any($1) and device_id = $2', [ids, pos2]),
    ).toBe(2);
  });

  it('upload reached the cloud but the acknowledgement was lost: resent, applied once', async () => {
    let dropAck = true;
    const flaky = new SyncEngine(
      hubDb,
      {
        snapshot: async (since) => cloud.app.getHubSnapshot.execute(await cloud.as(hubUser), since),
        upload: async (batch) => {
          const result = await cloud.app.ingestHubBatch.execute(await cloud.as(hubUser), batch);
          if (dropAck) {
            dropAck = false;
            throw new Error('socket hang up');
          }
          return result;
        },
      },
      { newId: randomUUID },
    );
    const order = await sellOnHub(f.products.chicken, 1);
    await flaky.syncOnce(); // applied in the cloud, acknowledgement lost
    expect((await flaky.status()).outbox.pending).toBeGreaterThan(0);
    await flaky.syncOnce(); // resent with a new batch id
    expect((await flaky.status()).outbox.pending).toBe(0);
    expect(await count(cloudDb, 'orders where id = $1', [order.id])).toBe(1);
    expect(await count(cloudDb, 'payments where order_id = $1', [order.id])).toBe(1);
    expect(
      await count(cloudDb, `audit_logs where entity_id = $1::text and action = 'payment.record'`, [order.id]),
    ).toBeLessThanOrEqual(1);
  });

  it('a staff member deactivated in the back office can no longer act on the hub after the next sync', async () => {
    const [cashierStaff] = await cloudDb.query<{ id: string }>('select id from staff where user_id = $1', [
      f.authUsers.cashier,
    ]);
    await cloudDb.query('update staff set is_active = false where id = $1', [cashierStaff!.id]);
    await engine.syncOnce();
    await expect(sellOnHub(f.products.coke, 1)).rejects.toThrow();
    await cloudDb.query('update staff set is_active = true where id = $1', [cashierStaff!.id]);
    await engine.syncOnce();
  });

  it('a hub that is not attached to the branch cannot upload', async () => {
    const manager = await cloud.as(f.authUsers.manager);
    await cloud.app.setBranchHub.execute(manager, f.branchId, { hubDeviceId: null });
    await expect(
      cloud.app.ingestHubBatch.execute(await cloud.as(hubUser), { batchId: uuid(), records: [] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Detached: the web POS works for the branch again.
    const cashier = await cloud.as(f.authUsers.cashier, f.devices.pos);
    const order = await cloud.app.submitOrder.execute(cashier, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(f.products.coke, 1)],
    });
    // The web POS continues the day's numbering after the hub's orders; no number is reused.
    const [{ max }] = (await hubDb.query<{ max: number }>(
      'select max(order_number)::int as max from orders',
    )) as [{ max: number }];
    expect(order.orderNumber).toBeGreaterThan(max);
    // Re-attaching while the web POS has an open order is refused (the hub could not see it).
    await expect(cloud.app.setBranchHub.execute(manager, f.branchId, { hubDeviceId })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await cloud.app.cancelOrder.execute(manager, order.id, { reason: 'Hub taking over' });
    await cloud.app.setBranchHub.execute(manager, f.branchId, { hubDeviceId });
    // The hub continues after the web POS's numbers too.
    await engine.syncOnce();
    const next = await sellOnHub(f.products.coke, 1);
    expect(next.orderNumber).toBeGreaterThan(order.orderNumber);
    await engine.syncOnce();
    expect((await engine.status()).outbox.conflicts).toBe(0);
  });

  it('only a hub device can read snapshots or upload', async () => {
    await expect(
      cloud.app.getHubSnapshot.execute(await cloud.as(f.authUsers.manager), null),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      cloud.app.ingestHubBatch.execute(await cloud.as(f.authUsers.agent), { batchId: uuid(), records: [] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
