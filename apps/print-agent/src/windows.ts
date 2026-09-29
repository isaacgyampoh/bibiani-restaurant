import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrinterDriver, SendResult } from './driver';

/**
 * USB (or any locally installed) receipt printers on Windows: the ESC/POS bytes are handed to the
 * Windows print spooler as a RAW document for the printer with that exact name (as listed in
 * Windows "Printers & scanners"). Uses PowerShell with the Windows spooler API; no native modules.
 * The printer name is passed as a script argument, never through a shell, so it cannot inject.
 */
const RAW_PRINT = String.raw`
param([string]$Printer, [string]$File)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class MyFoodRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr h, byte[] bytes, int count, out int written);
  public static string Send(string name, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(name, out h, IntPtr.Zero)) return "ERR open " + Marshal.GetLastWin32Error();
    try {
      var di = new DOCINFO { pDocName = "MY FOOD", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, di) == 0) return "ERR doc " + Marshal.GetLastWin32Error();
      StartPagePrinter(h);
      int written;
      bool ok = WritePrinter(h, bytes, bytes.Length, out written);
      EndPagePrinter(h);
      EndDocPrinter(h);
      return ok ? "OK " + written : "ERR write " + Marshal.GetLastWin32Error() + " " + written;
    } finally { ClosePrinter(h); }
  }
}
"@
[Console]::Out.Write([MyFoodRawPrint]::Send($Printer, [IO.File]::ReadAllBytes($File)))
`;

const PROBE = String.raw`
param([string]$Printer)
$p = Get-Printer -Name $Printer -ErrorAction SilentlyContinue
if (-not $p) { [Console]::Out.Write('MISSING'); exit }
[Console]::Out.Write(($p | Select-Object Name, PrinterStatus, WorkOffline | ConvertTo-Json -Compress))
`;

const LIST = String.raw`
Get-Printer | Select-Object Name, PortName, DriverName, Shared | ConvertTo-Json -Compress
`;

export type PowerShellRunner = (script: string, args: string[], timeoutMs: number) => Promise<string>;

/** Runs a PowerShell script file with literal arguments (no shell). */
export const runPowerShell: PowerShellRunner = (script, args, timeoutMs) => {
  const dir = mkdtempSync(join(tmpdir(), 'myfood-ps-'));
  const file = join(dir, 'script.ps1');
  writeFileSync(file, script, 'utf8');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        rmSync(dir, { recursive: true, force: true });
        if (error) reject(new Error((stderr || error.message).trim().split('\n')[0] ?? 'PowerShell failed'));
        else resolve(stdout.trim());
      },
    );
  });
};

/** Interprets the RAW print script's answer ("OK <bytes>" / "ERR <step> <code>"). */
export function parseRawPrintResult(out: string, length: number): SendResult {
  if (out.startsWith('OK ')) return { ok: true, bytesWritten: Number(out.slice(3)) || length };
  const code = Number(/ERR \w+ (\d+)/.exec(out)?.[1]);
  const reason =
    code === 1801
      ? 'no Windows printer with this name'
      : code === 5
        ? 'Windows refused access to the printer'
        : `Windows could not print (${out || 'no answer'})`;
  return { ok: false, bytesWritten: Number(/ERR write \d+ (\d+)/.exec(out)?.[1] ?? 0), error: reason };
}

export class WindowsSpoolerDriver implements PrinterDriver {
  constructor(
    private readonly printerName: string,
    private readonly run: PowerShellRunner = runPowerShell,
  ) {}

  async send(bytes: Uint8Array): Promise<SendResult> {
    if (process.platform !== 'win32' && this.run === runPowerShell)
      return { ok: false, bytesWritten: 0, error: 'USB printers are printed through Windows only' };
    const dir = mkdtempSync(join(tmpdir(), 'myfood-job-'));
    const file = join(dir, 'job.bin');
    writeFileSync(file, bytes);
    try {
      return parseRawPrintResult(
        await this.run(RAW_PRINT, ['-Printer', this.printerName, '-File', file], 30_000),
        bytes.length,
      );
    } catch (e) {
      return { ok: false, bytesWritten: 0, error: (e as Error).message };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async probe(): Promise<{ ok: boolean; error?: string }> {
    if (process.platform !== 'win32' && this.run === runPowerShell)
      return { ok: false, error: 'USB printers are printed through Windows only' };
    try {
      const out = await this.run(PROBE, ['-Printer', this.printerName], 20_000);
      if (out === 'MISSING')
        return { ok: false, error: `Windows has no printer named "${this.printerName}"` };
      const p = JSON.parse(out) as { PrinterStatus?: number | string; WorkOffline?: boolean };
      if (p.WorkOffline) return { ok: false, error: 'Windows shows this printer as offline' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

export interface WindowsPrinter {
  name: string;
  port: string;
  driver: string;
  /** Plugged in by USB (port USBnnn), as opposed to a network or virtual printer. */
  usb: boolean;
}

/** The printers installed in Windows on this PC (USB receipt printers show a USBnnn port). */
export async function listWindowsPrinters(run: PowerShellRunner = runPowerShell): Promise<WindowsPrinter[]> {
  if (process.platform !== 'win32' && run === runPowerShell) return [];
  const out = await run(LIST, [], 20_000);
  if (!out) return [];
  const rows = JSON.parse(out) as
    | { Name: string; PortName: string; DriverName: string }
    | { Name: string; PortName: string; DriverName: string }[];
  return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
    name: r.Name,
    port: r.PortName ?? '',
    driver: r.DriverName ?? '',
    usb: /^USB\d+/i.test(r.PortName ?? ''),
  }));
}
