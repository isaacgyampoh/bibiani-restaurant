import { type ApiClient, ApiError } from '@rp/client-core';
import type { AgentConfigView, ClaimedPrintJobView } from '@rp/contracts';
import { render } from '@rp/escpos';
import type { PrinterDriver } from './driver';
import type { Outcome, PrintJournal } from './journal';

type Printer = AgentConfigView['printers'][number];

export interface AgentLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface PrintAgentOptions {
  api: Pick<ApiClient, 'agentConfig' | 'claimPrintJobs' | 'reportPrintJob' | 'heartbeat'>;
  driverFor: (printer: Printer) => PrinterDriver;
  journal: PrintJournal;
  logger: AgentLogger;
  appVersion: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  claimLimit?: number;
}

/**
 * Leases print jobs from the API, prints them, reports outcomes. Holds no
 * authoritative state: if this process dies, leases expire and the server
 * re-queues the jobs (marked as possible duplicates).
 */
export class PrintAgent {
  private printers = new Map<string, Printer>();
  private timers: NodeJS.Timeout[] = [];
  private cycling: Promise<number> | null = null;

  constructor(private readonly o: PrintAgentOptions) {}

  async loadConfig(): Promise<void> {
    const config = await this.o.api.agentConfig();
    this.printers = new Map(config.printers.filter((p) => p.isActive).map((p) => [p.printerId, p]));
    this.o.logger.info('agent.config_loaded', {
      agentDeviceId: config.agentDeviceId,
      printers: config.printers.map((p) => p.name),
    });
  }

  start(): void {
    const poll = this.o.pollIntervalMs ?? 3000;
    const beat = this.o.heartbeatIntervalMs ?? 30_000;
    const safely = (name: string, fn: () => Promise<unknown>) => () =>
      fn().catch((error) => this.o.logger.warn(`agent.${name}_failed`, { error: describe(error) }));
    void safely('startup', async () => {
      await this.loadConfig();
      await this.heartbeat();
      await this.cycle();
    })();
    this.timers.push(
      setInterval(
        safely('cycle', () => this.cycle()),
        poll,
      ),
    );
    this.timers.push(
      setInterval(
        safely('heartbeat', () => this.heartbeat()),
        beat,
      ),
    );
    this.timers.push(
      setInterval(
        safely('config', () => this.loadConfig()),
        5 * 60_000,
      ),
    );
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** One pass: flush unreported results, claim, print (printers in parallel, jobs in order per printer). Returns jobs handled. */
  cycle(): Promise<number> {
    this.cycling ??= this.doCycle().finally(() => {
      this.cycling = null;
    });
    return this.cycling;
  }

  private async doCycle(): Promise<number> {
    await this.flushUnreported();
    if (this.printers.size === 0) await this.loadConfig();
    const jobs = await this.o.api.claimPrintJobs({ limit: this.o.claimLimit ?? 10 });
    const byPrinter = new Map<string, ClaimedPrintJobView[]>();
    for (const job of jobs) byPrinter.set(job.printerId, [...(byPrinter.get(job.printerId) ?? []), job]);
    await Promise.all(
      [...byPrinter].map(async ([, list]) => {
        for (const job of list) await this.printOne(job);
      }),
    );
    return jobs.length;
  }

  private async printOne(job: ClaimedPrintJobView): Promise<void> {
    const { journal, logger } = this.o;
    const fields = {
      printJobId: job.id,
      orderId: job.orderId,
      ticketId: job.productionTicketId,
      printerId: job.printerId,
    };

    if (journal.alreadyPrinted(job.id)) {
      // Printed earlier but the server never got our answer: report, do not print twice.
      logger.info('print.already_printed', fields);
      journal.result(job.id, job.claimId, 'printed', null);
      await this.report(job.id, job.claimId, 'printed', null);
      return;
    }

    let printer = this.printers.get(job.printerId);
    if (!printer) {
      await this.loadConfig().catch(() => undefined);
      printer = this.printers.get(job.printerId);
    }
    if (!printer?.address) {
      await this.finish(job, 'failed_before_send', 'printer is not configured on this agent');
      return;
    }

    const bytes = render(job.document, {
      paperWidthMm: printer.paperWidthMm,
      possibleDuplicate: job.possibleDuplicate,
      isReprint: job.isReprint,
    });
    journal.sending(job.id, job.claimId);
    const result = await this.o.driverFor(printer).send(bytes);
    const outcome: Outcome = result.ok
      ? 'printed'
      : result.bytesWritten > 0
        ? 'failed_after_send'
        : 'failed_before_send';
    if (result.ok) logger.info('print.printed', { ...fields, printer: printer.name, bytes: bytes.length });
    else logger.warn('print.failed', { ...fields, printer: printer.name, outcome, error: result.error });
    await this.finish(job, outcome, result.error ?? null);
  }

  private async finish(job: ClaimedPrintJobView, outcome: Outcome, error: string | null): Promise<void> {
    this.o.journal.result(job.id, job.claimId, outcome, error);
    await this.report(job.id, job.claimId, outcome, error);
  }

  /** Reports a result. Network trouble leaves it in the journal for the next cycle; a stale lease is final. */
  private async report(
    jobId: string,
    claimId: string,
    outcome: Outcome,
    error: string | null,
  ): Promise<void> {
    try {
      await this.o.api.reportPrintJob(jobId, { claimId, outcome, error });
      this.o.journal.reported(jobId);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'STALE_PRINT_CLAIM' || e.code === 'NOT_FOUND')) {
        // Server already moved on (lease expired -> re-queued as possible duplicate). Nothing to add.
        this.o.journal.reported(jobId);
        this.o.logger.info('print.report_superseded', { printJobId: jobId, outcome });
        return;
      }
      this.o.logger.warn('print.report_deferred', { printJobId: jobId, outcome, error: describe(e) });
    }
  }

  private async flushUnreported(): Promise<void> {
    for (const e of this.o.journal.unreported()) {
      await this.report(e.jobId, e.claimId, e.outcome ?? 'failed_after_send', e.error ?? null);
    }
  }

  async heartbeat(): Promise<void> {
    const printers = await Promise.all(
      [...this.printers.values()].map(async (p) => {
        const r = p.address ? await this.o.driverFor(p).probe() : { ok: false, error: 'no address' };
        if (!r.ok)
          this.o.logger.warn('printer.offline', { printerId: p.printerId, printer: p.name, error: r.error });
        return { printerId: p.printerId, ok: r.ok, error: r.error ?? null };
      }),
    );
    await this.o.api.heartbeat({ appVersion: this.o.appVersion, printers });
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
