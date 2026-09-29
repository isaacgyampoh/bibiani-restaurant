import { ApiClient } from '@rp/client-core';
import type { AgentConfigView, PairDeviceResult } from '@rp/contracts';
import {
  discoverNetworkPrinters,
  listWindowsPrinters,
  NetworkEscPosDriver,
  PrintAgent,
  type PrinterDriver,
  PrintJournal,
  supabaseDeviceTokenSource,
  testPage,
  type WindowsPrinter,
  WindowsSpoolerDriver,
} from '@rp/print-agent';

/**
 * MY FOOD Printing: the program on one PC in the restaurant that sends kitchen tickets, receipts
 * and bills to the printers. It pairs with MY FOOD like any device (a code entered in Devices &
 * printing, no password), then runs the print agent: it collects print jobs from MY FOOD and
 * prints them on network printers (IP, port 9100) and on USB printers plugged into this PC.
 * This module has no Electron code, so it is tested against the real API.
 */
export interface SavedPairing {
  refreshToken: string;
  deviceId: string;
  deviceName: string;
}

export interface PairingStore {
  load(): SavedPairing | null;
  save(p: SavedPairing | null): void;
  /** The latest rotated refresh token (kept with the pairing). */
  saveToken(refreshToken: string): void;
}

export interface StationPrinter {
  id: string;
  name: string;
  connection: 'network_escpos' | 'usb_escpos';
  address: string | null;
  paperWidthMm: number;
  reachable: boolean | null;
  error: string | null;
}

export interface StationStatus {
  phase: 'pairing' | 'running' | 'error';
  pairing: { code: string; expiresAt: string } | null;
  message: string | null;
  device: { name: string } | null;
  cloud: 'ok' | 'unreachable' | 'unknown';
  lastContactAt: string | null;
  printers: StationPrinter[];
  recent: { at: string; ok: boolean; text: string }[];
}

type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface StationOptions {
  cloudUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  store: PairingStore;
  journalFile: string;
  version: string;
  log: { info: Log; warn: Log; error: Log };
  fetch?: typeof fetch;
  /** Tests: how the paired device gets its access token. */
  tokenSourceFor?: (saved: SavedPairing) => () => Promise<string>;
  pollIntervalMs?: number;
  /** How often the PC asks whether its code was entered (the server allows 40 a minute). */
  pairingPollMs?: number;
}

const driverFor = (p: { connection: string; address: string | null; name: string }): PrinterDriver => {
  if (!p.address) throw new Error(`${p.name} has no address in MY FOOD`);
  return p.connection === 'usb_escpos'
    ? new WindowsSpoolerDriver(p.address)
    : new NetworkEscPosDriver(p.address);
};

export class PrintStation {
  private state: StationStatus = {
    phase: 'pairing',
    pairing: null,
    message: null,
    device: null,
    cloud: 'unknown',
    lastContactAt: null,
    printers: [],
    recent: [],
  };
  private agent: PrintAgent | null = null;
  private api: ApiClient | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private pairingRun = 0;
  /** Why the last pairing attempt did not work; shown with the next code until pairing succeeds. */
  private pairingProblem: string | null = null;
  /** The secret of the code on screen (memory only): named when it is replaced. */
  private pairingSecret: string | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: StationOptions) {
    this.fetchImpl = o.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  status(): StationStatus {
    return structuredClone(this.state);
  }

  start(): void {
    const saved = this.o.store.load();
    if (saved) this.run(saved);
    else void this.beginPairing();
  }

  stop(): void {
    this.pairingRun++;
    this.agent?.stop();
    this.agent = null;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Forgets this PC's pairing (it stops printing until paired again). */
  forget(): void {
    this.stop();
    this.o.store.save(null);
    this.state = { ...this.state, device: null, printers: [], phase: 'pairing', message: null };
    void this.beginPairing();
  }

  /**
   * Pairing state machine: request ONE code (declaring this PC a print agent) → show it → ask every
   * few seconds whether it was entered → paired: save the login, stop, print. The code is replaced
   * only when the server says it expired, or when someone presses "Show a new code" (the old code
   * then stops working). Network errors and rate limits keep the same code on screen.
   */
  async beginPairing(replaceCurrent = false): Promise<void> {
    const run = ++this.pairingRun;
    let previous = replaceCurrent ? this.pairingSecret : null;
    this.state = { ...this.state, phase: 'pairing', pairing: null, message: this.pairingProblem };
    while (run === this.pairingRun) {
      let request: { code: string; secret: string; expiresAt: string };
      try {
        request = await this.post('/v1/devices/pairing-requests', {
          kind: 'print_agent',
          replaces: previous,
        });
      } catch (e) {
        this.state = {
          ...this.state,
          cloud: 'unreachable',
          message: `Cannot reach MY FOOD: ${(e as Error).message}`,
        };
        await sleep(10_000);
        continue;
      }
      this.pairingSecret = request.secret;
      previous = request.secret;
      this.state = {
        ...this.state,
        cloud: 'ok',
        message: this.pairingProblem,
        // Shown as "about N minutes left", counted from now: the PC's clock may be wrong.
        pairing: { code: request.code, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
      };
      let wait = this.o.pairingPollMs ?? 3000;
      for (;;) {
        await sleep(wait);
        if (run !== this.pairingRun) return;
        let result: (PairDeviceResult & { status?: string }) | { status: 'waiting' };
        try {
          result = await this.post('/v1/devices/pairing-requests/collect', { secret: request.secret });
        } catch (e) {
          // The server says this code is over (expired or replaced): get the next one.
          if ((e as { code?: string }).code === 'PAIRING_CODE_INVALID') break;
          // Anything else (no internet, too many requests): keep the same code and try again later.
          this.state = { ...this.state, message: `Checking for approval… (${(e as Error).message})` };
          wait = Math.min(wait * 2, 30_000);
          continue;
        }
        wait = this.o.pairingPollMs ?? 3000;
        if (this.state.message && this.state.message !== this.pairingProblem)
          this.state = { ...this.state, message: this.pairingProblem };
        if (!('device' in result) || !result.device) continue;
        if (result.device.kind !== 'print_agent') {
          // The server refuses this since 20260929000200; kept as a last safety net.
          this.pairingProblem = `The code was used for "${result.device.name}", which is not a print agent. Enter the new code on the print agent (for example PRINT-AGENT-01).`;
          break;
        }
        const saved = {
          refreshToken: result.session.refreshToken,
          deviceId: result.device.id,
          deviceName: result.device.name,
        };
        this.pairingProblem = null;
        this.pairingSecret = null;
        this.o.store.save(saved);
        this.o.log.info('printing.paired', { device: saved.deviceName });
        this.run(saved);
        return;
      }
    }
  }

  /** "Show a new code": the current code stops working and exactly one new code is shown. */
  newCode(): void {
    if (this.state.phase !== 'pairing') return;
    void this.beginPairing(true);
  }

  private run(saved: SavedPairing): void {
    this.pairingRun++;
    this.state = {
      ...this.state,
      phase: 'running',
      pairing: null,
      device: { name: saved.deviceName },
      message: null,
    };
    const token =
      this.o.tokenSourceFor?.(saved) ??
      supabaseDeviceTokenSource(this.o.supabaseUrl, this.o.supabaseAnonKey, saved.refreshToken, {
        load: () => this.o.store.load()?.refreshToken ?? null,
        save: (t) => this.o.store.saveToken(t),
      });
    const getAccessToken = async () => {
      try {
        const t = await token();
        return t;
      } catch (e) {
        this.state = {
          ...this.state,
          phase: 'error',
          message:
            'This PC is no longer connected to MY FOOD (it was removed or paired again elsewhere). Press "Connect again" and enter the new code in Devices & printing.',
        };
        throw e;
      }
    };
    this.api = new ApiClient({
      baseUrl: this.o.cloudUrl,
      getAccessToken,
      fetch: this.fetchImpl,
      timeoutMs: 20_000,
    });
    const watch =
      (level: 'info' | 'warn' | 'error'): Log =>
      (event, fields = {}) => {
        this.o.log[level](event, fields);
        if (event === 'print.printed') this.note(true, `Printed on ${String(fields.printer)}`);
        else if (event === 'print.failed')
          this.note(false, `Could not print on ${String(fields.printer)}: ${String(fields.error)}`);
        else if (event.startsWith('agent.') && event.endsWith('_failed')) {
          this.state = { ...this.state, cloud: 'unreachable' };
          this.note(
            false,
            `Cannot reach MY FOOD (${String(fields.error)}). Jobs wait and print when the connection is back.`,
          );
        }
      };
    this.agent = new PrintAgent({
      api: this.api,
      driverFor,
      journal: new PrintJournal(this.o.journalFile),
      logger: { info: watch('info'), warn: watch('warn'), error: watch('error') },
      appVersion: `printing-${this.o.version}`,
      pollIntervalMs: this.o.pollIntervalMs ?? 3000,
    });
    this.agent.start();
    void this.refreshPrinters();
    this.timers.push(setInterval(() => void this.refreshPrinters(), 30_000));
  }

  /** The printers MY FOOD assigns to this agent, and whether this PC can reach each one. */
  async refreshPrinters(): Promise<void> {
    if (!this.api) return;
    let config: AgentConfigView;
    try {
      config = await this.api.agentConfig();
    } catch {
      this.state = { ...this.state, cloud: 'unreachable' };
      return;
    }
    const printers = await Promise.all(
      config.printers
        .filter((p) => p.isActive)
        .map(async (p): Promise<StationPrinter> => {
          const probe = p.address
            ? await driverFor(p).probe()
            : { ok: false, error: 'no address set in MY FOOD' };
          return {
            id: p.printerId,
            name: p.name,
            connection: p.connection as StationPrinter['connection'],
            address: p.address,
            paperWidthMm: p.paperWidthMm,
            reachable: probe.ok,
            error: probe.ok ? null : (probe.error ?? 'not reachable'),
          };
        }),
    );
    this.state = { ...this.state, cloud: 'ok', lastContactAt: new Date().toISOString(), printers };
  }

  /** Network printers found on this PC's networks (port 9100). */
  scan(): Promise<{ address: string; network: string }[]> {
    return discoverNetworkPrinters();
  }

  usbPrinters(): Promise<WindowsPrinter[]> {
    return listWindowsPrinters();
  }

  /** Prints a check page directly (not through MY FOOD), to confirm an address or printer name. */
  async testPrint(p: {
    connection: 'network_escpos' | 'usb_escpos';
    address: string;
    paperWidthMm: 58 | 80;
  }) {
    const driver = driverFor({ ...p, name: p.address });
    const result = await driver.send(testPage(p.paperWidthMm, `Printed by MY FOOD Printing to ${p.address}`));
    this.note(
      result.ok,
      result.ok ? `Test page sent to ${p.address}` : `Test page to ${p.address} failed: ${result.error}`,
    );
    return result;
  }

  private note(ok: boolean, text: string) {
    this.state = {
      ...this.state,
      recent: [{ at: new Date().toISOString(), ok, text }, ...this.state.recent].slice(0, 30),
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.o.cloudUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => null)) as
      | (T & { error?: { message?: string; code?: string } })
      | null;
    if (!res.ok)
      throw Object.assign(new Error(json?.error?.message ?? `MY FOOD answered ${res.status}`), {
        code: json?.error?.code,
      });
    return json as T;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
