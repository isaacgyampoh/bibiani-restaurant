import { ConfigSchemas } from '@rp/contracts';
import { describe, expect, it } from 'vitest';
import { listWindowsPrinters, looksLikeRouter, parseRawPrintResult, WindowsSpoolerDriver } from '../src/lib';

/** USB printers go through the Windows spooler; here PowerShell is replaced by a recorder. */
describe('USB printers on Windows', () => {
  it('sends the bytes as a RAW job to the named printer, passing the name as an argument (no shell)', async () => {
    const calls: { script: string; args: string[] }[] = [];
    const driver = new WindowsSpoolerDriver('POS-80 "Receipt"; del C:\\*', async (script, args) => {
      calls.push({ script, args });
      return 'OK 12';
    });
    const result = await driver.send(new Uint8Array(12));
    expect(result).toEqual({ ok: true, bytesWritten: 12 });
    expect(calls[0]!.args.slice(0, 2)).toEqual(['-Printer', 'POS-80 "Receipt"; del C:\\*']);
    expect(calls[0]!.script).toContain('pDataType = "RAW"');
    expect(calls[0]!.script).not.toContain('POS-80');
  });

  it('explains Windows errors in plain words', () => {
    expect(parseRawPrintResult('ERR open 1801', 10)).toMatchObject({
      ok: false,
      error: 'no Windows printer with this name',
    });
    expect(parseRawPrintResult('ERR write 5 4', 10)).toMatchObject({ ok: false, bytesWritten: 4 });
  });

  it('checks the printer exists and is not offline', async () => {
    const missing = new WindowsSpoolerDriver('Nope', async () => 'MISSING');
    expect(await missing.probe()).toEqual({ ok: false, error: 'Windows has no printer named "Nope"' });
    const offline = new WindowsSpoolerDriver('P', async () =>
      JSON.stringify({ Name: 'P', WorkOffline: true }),
    );
    expect((await offline.probe()).ok).toBe(false);
    const ready = new WindowsSpoolerDriver('P', async () =>
      JSON.stringify({ Name: 'P', WorkOffline: false }),
    );
    expect(await ready.probe()).toEqual({ ok: true });
  });

  it('lists Windows printers and marks USB ones', async () => {
    const list = await listWindowsPrinters(async () =>
      JSON.stringify([
        { Name: 'XP-80C', PortName: 'USB001', DriverName: 'XP-80' },
        { Name: 'Microsoft Print to PDF', PortName: 'PORTPROMPT:', DriverName: 'MS' },
      ]),
    );
    expect(list.map((p) => [p.name, p.usb])).toEqual([
      ['XP-80C', true],
      ['Microsoft Print to PDF', false],
    ]);
    const one = await listWindowsPrinters(async () =>
      JSON.stringify({ Name: 'Solo', PortName: 'USB002', DriverName: 'D' }),
    );
    expect(one).toHaveLength(1);
  });
});

describe('Printer addresses', () => {
  it('flags addresses that are usually the router', () => {
    expect(looksLikeRouter('192.168.0.1')).toBe(true);
    expect(looksLikeRouter('192.168.1.254:9100')).toBe(true);
    expect(looksLikeRouter('192.168.1.50')).toBe(false);
  });

  it('network printers need an IP address; USB printers take the Windows printer name', () => {
    const device = (printer: object) =>
      ConfigSchemas.device.safeParse({
        branchId: '00000000-0000-4000-8000-000000000001',
        kind: 'printer',
        name: 'RECEIPT',
        printer,
      });
    expect(device({ address: '192.168.1.50' }).success).toBe(true);
    expect(device({ address: 'EPSON TM-T20 Receipt' }).success).toBe(false);
    expect(device({ connection: 'usb_escpos', address: 'EPSON TM-T20 Receipt' }).success).toBe(true);
    expect(device({ connection: 'usb_escpos', address: 'bad"name' }).success).toBe(false);
  });
});
