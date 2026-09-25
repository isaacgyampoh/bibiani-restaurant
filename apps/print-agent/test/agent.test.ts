import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@rp/client-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHttpHarness, type HttpHarness } from '../../api/test/harness';
import { PrintAgent } from '../src/agent';
import { NetworkEscPosDriver } from '../src/driver';
import { PrintJournal } from '../src/journal';
import { FakePrinter } from './fake-printer';

const uuid = () => randomUUID();
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('Print agent against the real API and TCP printers', () => {
  let h: HttpHarness;
  const printers = new Map<string, FakePrinter>();

  beforeAll(async () => {
    h = await createHttpHarness();
    for (const name of [
      'KITCHEN-PRINTER-01',
      'GRILL-PRINTER-01',
      'PASTRY-PRINTER-01',
      'DRINKS-PRINTER-01',
      'PASTRY-PRINTER-02',
      'BACKUP-PRINTER-01',
      'RECEIPT-PRINTER-01',
    ]) {
      const p = new FakePrinter();
      await p.start();
      printers.set(name, p);
    }
  });
  afterEach(() => {
    for (const p of printers.values()) p.jobs.length = 0;
  });
  afterAll(async () => {
    for (const p of printers.values()) await p.stop();
    await h.db.close();
  });

  function agent(options: { journalFile?: string | null; api?: PrintAgent['o' & keyof PrintAgent] } = {}) {
    const api = h.client(h.f.authUsers.agent);
    return new PrintAgent({
      api: (options.api as never) ?? api,
      // Printer addresses in the database are LAN IPs; in tests each maps to a local fake printer.
      driverFor: (p) => new NetworkEscPosDriver(`127.0.0.1:${printers.get(p.name)!.port}`, 2000),
      journal: new PrintJournal(options.journalFile ?? null),
      logger: quiet,
      appVersion: 'test',
    });
  }

  async function scenarioA() {
    return h.client(h.f.authUsers.waiter).submitOrder({
      orderId: uuid(),
      branchId: h.f.branchId,
      areaId: h.f.areas.hall,
      tableId: h.f.tables['12'],
      items: [
        { id: uuid(), productId: h.f.products.jollof, quantity: 2, modifierIds: [h.f.modifiers.noPepper] },
        { id: uuid(), productId: h.f.products.chicken, quantity: 2, modifierIds: [] },
        { id: uuid(), productId: h.f.products.meatPie, quantity: 2, modifierIds: [] },
        { id: uuid(), productId: h.f.products.coke, quantity: 2, modifierIds: [] },
      ],
      send: { submissionId: uuid() },
    });
  }

  it('prints each station ticket on its own printer and confirms to the server', async () => {
    const order = await scenarioA();
    const a = agent();
    await a.loadConfig();
    expect(await a.cycle()).toBe(4);

    const kitchen = printers.get('KITCHEN-PRINTER-01')!;
    expect(kitchen.jobs).toHaveLength(1);
    expect(kitchen.text(0)).toContain('MAIN KITCHEN');
    expect(kitchen.text(0)).toContain(`ORDER #${order.orderNumber}`);
    expect(kitchen.text(0)).toContain('HALL - TABLE 12');
    expect(kitchen.text(0)).toContain('2 x JOLLOF');
    expect(kitchen.text(0)).toContain('+ NO PEPPER');
    expect(kitchen.text(0)).not.toContain('GRILLED CHICKEN');
    expect(printers.get('GRILL-PRINTER-01')!.text(0)).toContain('2 x GRILLED CHICKEN');
    expect(printers.get('PASTRY-PRINTER-01')!.text(0)).toContain('2 x MEAT PIE');
    expect(printers.get('DRINKS-PRINTER-01')!.text(0)).toContain('2 x COKE');

    const view = await h.client(h.f.authUsers.manager).getOrder(order.id);
    expect(view.tickets.flatMap((t) => t.printJobs.map((j) => j.status))).toEqual([
      'printed',
      'printed',
      'printed',
      'printed',
    ]);
    await h
      .client(h.f.authUsers.waiter)
      .fulfilOrder(order.id)
      .catch(() => undefined); // free the table for later tests
  });

  it('offline printer: the ticket waits in the queue and prints once the printer is back', async () => {
    const grill = printers.get('GRILL-PRINTER-01')!;
    const port = grill.port;
    await grill.stop();
    const order = await h.client(h.f.authUsers.cashier).submitOrder({
      orderId: uuid(),
      branchId: h.f.branchId,
      areaId: h.f.areas.takeaway,
      items: [{ id: uuid(), productId: h.f.products.chicken, quantity: 1, modifierIds: [] }],
      send: { submissionId: uuid() },
    });
    const a = agent();
    await a.loadConfig();
    await a.cycle();

    const manager = h.client(h.f.authUsers.manager);
    let view = await manager.getOrder(order.id);
    expect(view.tickets[0]!.printJobs[0]!.status).toBe('failed');
    const board = await manager.stationBoard(h.f.stations.grill);
    expect(board.printerAlerts[0]).toMatchObject({ printerName: 'GRILL-PRINTER-01', failedJobs: 1 });
    expect(board.tickets.some((t) => t.orderId === order.id)).toBe(true); // kitchen still sees it on screen

    await grill.start(port);
    h.t.clock.advance(10);
    await a.cycle();
    view = await manager.getOrder(order.id);
    expect(view.tickets[0]!.printJobs[0]!.status).toBe('printed');
    expect(grill.jobs).toHaveLength(1);
  });

  it('never prints twice when the agent printed but could not report before its lease expired', async () => {
    const order = await h.client(h.f.authUsers.cashier).submitOrder({
      orderId: uuid(),
      branchId: h.f.branchId,
      areaId: h.f.areas.takeaway,
      items: [{ id: uuid(), productId: h.f.products.coke, quantity: 1, modifierIds: [] }],
      send: { submissionId: uuid() },
    });
    const journalFile = join(mkdtempSync(join(tmpdir(), 'agent-')), 'journal.jsonl');
    const real = h.client(h.f.authUsers.agent);
    const offlineReports = {
      agentConfig: real.agentConfig,
      claimPrintJobs: real.claimPrintJobs,
      heartbeat: real.heartbeat,
      reportPrintJob: async () => {
        throw ApiError.network(new Error('Wi-Fi down'));
      },
    };
    const first = agent({ journalFile, api: offlineReports as never });
    await first.loadConfig();
    await first.cycle();
    const drinks = printers.get('DRINKS-PRINTER-01')!;
    expect(drinks.jobs).toHaveLength(1);

    // Case 1: the agent restarts and re-reports before anyone re-leased the job: accepted, no duplicate flag.
    const restarted = agent({ journalFile });
    await restarted.loadConfig();
    h.t.clock.advance(120);
    await restarted.cycle();
    expect(drinks.jobs).toHaveLength(1);
    const view = await h.client(h.f.authUsers.manager).getOrder(order.id);
    expect(view.tickets[0]!.printJobs[0]).toMatchObject({ status: 'printed', possibleDuplicate: false });
  });

  it('never prints twice even when the job was re-leased while the result was stuck on the agent', async () => {
    const order = await h.client(h.f.authUsers.cashier).submitOrder({
      orderId: uuid(),
      branchId: h.f.branchId,
      areaId: h.f.areas.takeaway,
      items: [{ id: uuid(), productId: h.f.products.coke, quantity: 1, modifierIds: [] }],
      send: { submissionId: uuid() },
    });
    const journalFile = join(mkdtempSync(join(tmpdir(), 'agent-')), 'journal.jsonl');
    const real = h.client(h.f.authUsers.agent);
    const reportsFail = {
      agentConfig: real.agentConfig,
      claimPrintJobs: real.claimPrintJobs,
      heartbeat: real.heartbeat,
      reportPrintJob: async () => {
        throw ApiError.network(new Error('Wi-Fi down'));
      },
    };
    const flaky = agent({ journalFile, api: reportsFail as never });
    await flaky.loadConfig();
    await flaky.cycle(); // prints; report lost
    h.t.clock.advance(60); // lease expires; next claim sweeps it and re-queues as possible duplicate
    await flaky.cycle();
    h.t.clock.advance(60);
    await flaky.cycle(); // job leased again: journal says already printed, so it is NOT sent to the printer
    const drinks = printers.get('DRINKS-PRINTER-01')!;
    expect(drinks.jobs).toHaveLength(1);

    // Connectivity back: the stuck result is delivered against the current lease.
    const recovered = agent({ journalFile });
    await recovered.loadConfig();
    await recovered.cycle();
    expect(drinks.jobs).toHaveLength(1);
    const view = await h.client(h.f.authUsers.manager).getOrder(order.id);
    expect(view.tickets[0]!.printJobs[0]).toMatchObject({ status: 'printed', possibleDuplicate: true });
  });

  it('heartbeat reports printer reachability to the server', async () => {
    const backup = printers.get('BACKUP-PRINTER-01')!;
    const port = backup.port;
    await backup.stop();
    const a = agent();
    await a.loadConfig();
    await a.heartbeat();
    const [row] = await h.db.query<{ last_error: string | null; last_heartbeat_at: Date | null }>(
      `select p.last_error, (select last_heartbeat_at from devices where id = $2) as last_heartbeat_at
       from printers p where p.device_id = $1`,
      [h.f.printers.backup, h.f.devices.agent],
    );
    expect(row!.last_error).toMatch(/ECONNREFUSED/);
    expect(row!.last_heartbeat_at).not.toBeNull();
    await backup.start(port);
  });
});

describe('journal', () => {
  it('turns an interrupted send into a possible-duplicate failure after restart', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'journal-')), 'j.jsonl');
    const j1 = new PrintJournal(file);
    j1.sending('job-1', 'claim-1');
    const j2 = new PrintJournal(file);
    expect(j2.unreported()).toEqual([
      expect.objectContaining({
        jobId: 'job-1',
        outcome: 'failed_after_send',
        error: 'agent restarted during print',
      }),
    ]);
  });
});
