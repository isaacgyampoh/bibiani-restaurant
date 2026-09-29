import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanHosts } from '@rp/print-agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpHarness, type HttpHarness } from '../../api/test/harness';
import { type PairingStore, PrintStation, type SavedPairing } from '../src/printing/station';

/**
 * MY FOOD Printing against the real API (in-process) and a simulated network receipt printer:
 * the PC shows a code, a manager enters it on the print agent in Devices & printing, the PC
 * connects, and an order sent to the kitchen comes out of the printer.
 */
describe('MY FOOD Printing (the restaurant PC program)', () => {
  let h: HttpHarness;
  let printer: Server;
  let port = 0;
  const received: Buffer[] = [];
  let saved: SavedPairing | null = null;
  const store: PairingStore = {
    load: () => saved,
    save: (p) => {
      saved = p;
    },
    saveToken: (t) => {
      if (saved) saved = { ...saved, refreshToken: t };
    },
  };
  const until = async (check: () => boolean | Promise<boolean>, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`timed out; station: ${JSON.stringify(station?.status())}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const deviceUser = async (deviceId: string) =>
    (await h.db.query<{ u: string }>('select auth_user_id as u from devices where id = $1', [deviceId]))[0]!
      .u;
  let station: PrintStation;

  beforeAll(async () => {
    h = await createHttpHarness();
    printer = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (d) => chunks.push(d));
      socket.on('end', () => {
        if (chunks.length) received.push(Buffer.concat(chunks));
        socket.end();
      });
    });
    await new Promise<void>((r) => printer.listen(0, '127.0.0.1', r));
    port = (printer.address() as { port: number }).port;
    // The kitchen printer is on the network at 127.0.0.1:<port>, printed by AGENT-01.
    await h.db.query('update printers set address = $2, agent_device_id = $3 where device_id = $1', [
      h.f.printers.kitchen,
      `127.0.0.1:${port}`,
      h.f.devices.agent,
    ]);
    station = new PrintStation({
      cloudUrl: 'http://api.test',
      supabaseUrl: 'http://unused',
      supabaseAnonKey: 'unused',
      store,
      journalFile: join(mkdtempSync(join(tmpdir(), 'printing-')), 'journal.jsonl'),
      version: 'test',
      log: { info: () => {}, warn: () => {}, error: () => {} },
      fetch: h.fetch,
      tokenSourceFor: (s) => async () => h.token(await deviceUser(s.deviceId)),
      pollIntervalMs: 100,
      pairingPollMs: 1600,
    });
  });
  afterAll(async () => {
    station?.stop();
    printer?.close();
    await h?.db.close();
  });

  const approve = async (deviceId: string, code: string) =>
    h.fetch(`http://api.test/v1/admin/devices/${deviceId}/approve-pairing`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await h.token(h.f.authUsers.manager)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code }),
    });

  it('a code entered on a device that is not a print agent is refused on the PC with an explanation', async () => {
    station.start();
    await until(() => station.status().pairing !== null);
    const res = await approve(h.f.devices.display, station.status().pairing!.code);
    expect(res.status).toBe(200);
    await until(() => /not a print agent/.test(station.status().message ?? ''), 20_000);
    expect(saved).toBeNull();
  });

  it('shows a code; the manager enters it on the print agent; the PC connects and sees its printers', async () => {
    await until(() => station.status().pairing !== null, 20_000);
    const res = await approve(h.f.devices.agent, station.status().pairing!.code);
    expect(res.status).toBe(200);
    await until(() => station.status().phase === 'running');
    expect(station.status().device?.name).toBe('AGENT-01');
    expect(saved?.deviceId).toBe(h.f.devices.agent);
    await until(() => station.status().printers.some((p) => p.id === h.f.printers.kitchen));
    const kitchen = station.status().printers.find((p) => p.id === h.f.printers.kitchen)!;
    expect(kitchen).toMatchObject({
      reachable: true,
      connection: 'network_escpos',
      address: `127.0.0.1:${port}`,
    });
    // A printer with a wrong address is reported as not reachable, with the reason.
    expect(station.status().printers.find((p) => p.id === h.f.printers.grill)?.reachable).toBe(false);
  });

  it('an order sent to the kitchen prints on the network printer, once', async () => {
    const before = received.length;
    const cashier = await h.t.as(h.f.authUsers.cashier, h.f.devices.pos);
    const order = await h.t.app.submitOrder.execute(cashier, {
      orderId: randomUUID(),
      branchId: h.f.branchId,
      areaId: h.f.areas.takeaway,
      customerName: 'Printer test',
      items: [
        { id: randomUUID(), productId: h.f.products.jollof, quantity: 2, modifierIds: [], notes: null },
      ],
      send: { submissionId: randomUUID() },
    });
    await until(async () => {
      const [job] = await h.db.query<{ status: string }>(
        `select status from print_jobs where order_id = $1 and printer_id = $2`,
        [order.id, h.f.printers.kitchen],
      );
      return job?.status === 'printed';
    }, 15_000);
    expect(received.length).toBe(before + 1);
    expect(received.at(-1)!.toString('latin1')).toContain('JOLLOF');
    expect(station.status().recent[0]).toMatchObject({ ok: true });
  });

  it('a test page from the PC prints directly on a printer found by address', async () => {
    const before = received.length;
    const result = await station.testPrint({
      connection: 'network_escpos',
      address: `127.0.0.1:${port}`,
      paperWidthMm: 80,
    });
    expect(result.ok).toBe(true);
    await until(() => received.length === before + 1);
    expect(received.at(-1)!.toString('latin1')).toContain('MY FOOD PRINTER CHECK');
  });

  it('network search finds a printer listening on the printing port', async () => {
    expect(await scanHosts(['127.0.0.1', '127.0.0.2'], port, 300)).toEqual(['127.0.0.1']);
  });
});
