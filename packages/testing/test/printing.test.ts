import { PRINT_RETRY_POLICY } from '@rp/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestDatabase,
  type RestaurantFixture,
  seedRestaurant,
  type TestApp,
  type TestDatabase,
} from '../src';
import { line, uuid } from './helpers';

describe('TEST 5 — printer failures never lose a ticket', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'printing' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());

  const job = async (id: string) =>
    (
      await db.query<{
        status: string;
        attempts: number;
        possible_duplicate: boolean;
        printer_id: string;
        original_printer_id: string;
      }>(
        'select status, attempts, possible_duplicate, printer_id, original_printer_id from print_jobs where id = $1',
        [id],
      )
    )[0]!;

  async function orderFor(productId: string) {
    const cashier = await t.as(f.authUsers.cashier);
    return t.app.submitOrder.execute(cashier, {
      orderId: uuid(),
      branchId: f.branchId,
      areaId: f.areas.takeaway,
      items: [line(productId, 1)],
      send: { submissionId: uuid() },
    });
  }

  it('offline printer: order and ticket stay valid, job retries with backoff, then succeeds', async () => {
    const order = await orderFor(f.products.chicken);
    const agent = await t.as(f.authUsers.agent);
    const jobId = order.tickets[0]!.printJobs[0]!.id;

    const [claimed] = (await t.app.claimPrintJobs.execute(agent, { limit: 20 })).filter(
      (j) => j.id === jobId,
    );
    expect(claimed).toBeDefined();
    expect(
      claimed!.document.blocks.some((b) => b.type === 'text' && b.text === `ORDER #${order.orderNumber}`),
    ).toBe(true);

    // Printer unreachable before any byte was sent.
    const result = await t.app.reportPrintJobResult.execute(agent, jobId, {
      claimId: claimed!.claimId,
      outcome: 'failed_before_send',
      error: 'ECONNREFUSED 192.168.1.52:9100',
    });
    expect(result.status).toBe('failed');
    expect(await job(jobId)).toMatchObject({ status: 'failed', attempts: 1, possible_duplicate: false });

    // The order is untouched by the print failure and the KDS shows it with a printer alert.
    const view = await t.app.getOrder.execute(await t.as(f.authUsers.manager), order.id);
    expect(view.status).toBe('submitted');
    const board = await t.app.getStationBoard.execute(await t.as(f.authUsers.manager), f.stations.grill);
    expect(board.tickets.some((tk) => tk.orderId === order.id)).toBe(true);
    expect(board.printerAlerts[0]).toMatchObject({ printerName: 'GRILL-PRINTER-01', failedJobs: 1 });

    // Not claimable until the backoff elapses.
    expect((await t.app.claimPrintJobs.execute(agent, { limit: 20 })).some((j) => j.id === jobId)).toBe(
      false,
    );
    t.clock.advance(PRINT_RETRY_POLICY.backoffSeconds[0]!);
    const [retry] = (await t.app.claimPrintJobs.execute(agent, { limit: 20 })).filter((j) => j.id === jobId);
    expect(retry).toBeDefined();
    await t.app.reportPrintJobResult.execute(agent, jobId, { claimId: retry!.claimId, outcome: 'printed' });
    expect(await job(jobId)).toMatchObject({ status: 'printed', attempts: 2 });

    const attempts = await db.query(
      'select outcome from print_job_attempts where print_job_id = $1 order by id',
      [jobId],
    );
    expect(attempts.map((a) => a.outcome)).toEqual(['failed_before_send', 'printed']);
  });

  it('failure after bytes may have been sent: retry is marked POSSIBLE DUPLICATE', async () => {
    const order = await orderFor(f.products.coke);
    const agent = await t.as(f.authUsers.agent);
    const jobId = order.tickets[0]!.printJobs[0]!.id;
    const claim = (await t.app.claimPrintJobs.execute(agent, { limit: 20 })).find((j) => j.id === jobId)!;
    await t.app.reportPrintJobResult.execute(agent, jobId, {
      claimId: claim.claimId,
      outcome: 'failed_after_send',
      error: 'socket closed mid-write',
    });
    t.clock.advance(60);
    const again = (await t.app.claimPrintJobs.execute(agent, { limit: 20 })).find((j) => j.id === jobId)!;
    expect(again.possibleDuplicate).toBe(true);
  });

  it('agent crash (lease expiry) returns the job to the queue as a possible duplicate', async () => {
    const order = await orderFor(f.products.jollof);
    const agent = await t.as(f.authUsers.agent);
    const jobId = order.tickets[0]!.printJobs[0]!.id;
    const claim = (await t.app.claimPrintJobs.execute(agent, { limit: 20 })).find((j) => j.id === jobId)!;

    t.clock.advance(PRINT_RETRY_POLICY.leaseSeconds + 1);
    await t.app.claimPrintJobs.execute(agent, { limit: 20 }); // sweeps the expired lease
    expect(await job(jobId)).toMatchObject({ status: 'failed', possible_duplicate: true, attempts: 1 });

    // The crashed agent's late report is rejected: it cannot overwrite the newer state.
    await expect(
      t.app.reportPrintJobResult.execute(agent, jobId, { claimId: claim.claimId, outcome: 'printed' }),
    ).rejects.toMatchObject({ code: 'STALE_PRINT_CLAIM' });
  });

  it('repeated failures reroute to the backup printer, then go dead and stay visible until retried', async () => {
    const order = await orderFor(f.products.meatPie); // Pastry printer has a backup
    const agent = await t.as(f.authUsers.agent);
    const jobId = order.tickets[0]!.printJobs[0]!.id;

    const fail = async () => {
      t.clock.advance(120);
      const c = (await t.app.claimPrintJobs.execute(agent, { limit: 50 })).find((j) => j.id === jobId);
      expect(c, 'job should be claimable').toBeDefined();
      return t.app.reportPrintJobResult.execute(agent, jobId, {
        claimId: c!.claimId,
        outcome: 'failed_before_send',
        error: 'paper out',
      });
    };
    for (let i = 0; i < PRINT_RETRY_POLICY.rerouteToBackupAfterAttempts; i++) await fail();
    expect(await job(jobId)).toMatchObject({
      printer_id: f.printers.backup,
      original_printer_id: f.printers.pastry,
    });

    let last = { status: '' };
    for (let i = PRINT_RETRY_POLICY.rerouteToBackupAfterAttempts; i < PRINT_RETRY_POLICY.maxAttempts; i++)
      last = await fail();
    expect(last.status).toBe('dead');

    // Dead jobs are never deleted: visible in the queue and on the station board.
    const manager = await t.as(f.authUsers.manager);
    const queue = await t.app.getPrintQueue.execute(manager, f.branchId);
    expect(queue.jobs.find((j) => j.id === jobId)).toMatchObject({
      status: 'dead',
      orderNumber: order.orderNumber,
    });

    // A manager puts it back in the queue; the action is audited.
    await t.app.retryPrintJob.execute(manager, jobId);
    expect((await job(jobId)).status).toBe('pending');
    const audit = await db.query('select action from audit_logs where entity_id = $1', [jobId]);
    expect(audit.map((a) => a.action)).toEqual(['print_job.retry']);
  });

  it('only a print agent can claim jobs, and it only sees printers it drives', async () => {
    const cashier = await t.as(f.authUsers.cashier);
    await expect(t.app.claimPrintJobs.execute(cashier, { limit: 5 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const config = await t.app.getAgentConfig.execute(await t.as(f.authUsers.agent));
    expect(config.printers.map((p) => p.name)).toContain('KITCHEN-PRINTER-01');
    expect(config.printers).toHaveLength(7);
  });
});
