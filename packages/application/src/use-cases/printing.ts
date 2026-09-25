import type {
  AgentConfigView,
  ClaimedPrintJobView,
  ClaimPrintJobsCommand,
  PrintJobResultCommand,
  PrintQueueView,
} from '@rp/contracts';
import { applyPrintOutcome, DomainError, PRINT_RETRY_POLICY } from '@rp/domain';
import { authorize, type Principal, type RequestContext } from '../principal';
import { CommitLog, type Dependencies } from './shared';

function agentOf(principal: Principal): { deviceId: string; branchId: string } {
  const branchId = principal.grants[0]?.branchId;
  if (
    principal.kind !== 'device' ||
    principal.deviceKind !== 'print_agent' ||
    !principal.deviceId ||
    !branchId
  ) {
    throw new DomainError('FORBIDDEN', 'Only a paired print agent can do this');
  }
  authorize(principal, 'print.agent', branchId);
  return { deviceId: principal.deviceId, branchId };
}

export class GetAgentConfig {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext): Promise<AgentConfigView> {
    const agent = agentOf(ctx.principal);
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => ({
      agentDeviceId: agent.deviceId,
      branchId: agent.branchId,
      printers: await tx.printJobs.agentPrinters(agent.deviceId),
    }));
  }
}

/**
 * Leases ready jobs to the calling agent. Expired leases (agent crashed or lost
 * network mid-print) are first turned into failed attempts marked as possible
 * duplicates, so they are retried rather than lost.
 */
export class ClaimPrintJobs {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, cmd: ClaimPrintJobsCommand): Promise<ClaimedPrintJobView[]> {
    const agent = agentOf(ctx.principal);
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const jobs = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      for (const job of await tx.printJobs.expiredLeases(agent.deviceId, now)) {
        const backup = await tx.printJobs.backupPrinterFor(job.printerId);
        const next = applyPrintOutcome(job, 'lease_expired', now, backup);
        await tx.printJobs.appendAttempt({
          jobId: job.id,
          claimId: job.claimId!,
          agentDeviceId: job.claimedByDeviceId,
          printerId: job.printerId,
          outcome: 'lease_expired',
          error: 'Lease expired before the agent reported a result',
        });
        await tx.printJobs.update(job.id, {
          status: next.status,
          attempts: next.attempts,
          printerId: next.printerId,
          possibleDuplicate: next.possibleDuplicate,
          nextAttemptAt: next.nextAttemptAt ?? undefined,
          deadAt: next.deadAt,
          claimId: null,
          claimedByDeviceId: null,
          leaseExpiresAt: null,
          lastError: 'Lease expired',
        });
        log.add('print_job.lease_expired', { printJobId: job.id, orderId: job.orderId, next: next.status });
      }

      const ready = await tx.printJobs.lockReady(agent.deviceId, now, cmd.limit);
      const leaseExpiresAt = new Date(now.getTime() + PRINT_RETRY_POLICY.leaseSeconds * 1000);
      for (const job of ready) {
        await tx.printJobs.update(job.id, {
          status: 'claimed',
          claimId: this.deps.ids.uuid(),
          claimedByDeviceId: agent.deviceId,
          leaseExpiresAt,
          lastAttemptAt: now,
        });
      }
      const claimed = await tx.printJobs.claimed(ready.map((j) => j.id));
      if (claimed.length > 0) {
        log.add('print_job.claimed', {
          agentDeviceId: agent.deviceId,
          printJobIds: claimed.map((j) => j.id),
          orderIds: [...new Set(claimed.map((j) => j.orderId))],
        });
      }
      return claimed;
    });
    log.flush(this.deps.logger);
    return jobs.map((j) => ({ ...j, leaseExpiresAt: j.leaseExpiresAt.toISOString() }));
  }
}

/** Agent reports what happened. Reports for an old lease are rejected so a late answer cannot overwrite a newer attempt. */
export class ReportPrintJobResult {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, jobId: string, cmd: PrintJobResultCommand): Promise<{ status: string }> {
    const agent = agentOf(ctx.principal);
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const status = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const job = await tx.printJobs.findForUpdate(jobId);
      if (!job) throw new DomainError('NOT_FOUND', 'Print job not found', { jobId });
      if (
        job.status !== 'claimed' ||
        job.claimId !== cmd.claimId ||
        job.claimedByDeviceId !== agent.deviceId
      ) {
        throw new DomainError('STALE_PRINT_CLAIM', 'This print lease is no longer valid', {
          jobId,
          status: job.status,
        });
      }
      const backup = cmd.outcome === 'printed' ? null : await tx.printJobs.backupPrinterFor(job.printerId);
      const next = applyPrintOutcome(job, cmd.outcome, now, backup);
      await tx.printJobs.appendAttempt({
        jobId,
        claimId: cmd.claimId,
        agentDeviceId: agent.deviceId,
        printerId: job.printerId,
        outcome: cmd.outcome,
        error: cmd.error ?? null,
      });
      await tx.printJobs.update(jobId, {
        status: next.status,
        attempts: next.attempts,
        printerId: next.printerId,
        possibleDuplicate: next.possibleDuplicate,
        nextAttemptAt: next.nextAttemptAt ?? undefined,
        printedAt: next.printedAt,
        deadAt: next.deadAt,
        claimId: null,
        claimedByDeviceId: null,
        leaseExpiresAt: null,
        lastError: cmd.outcome === 'printed' ? null : (cmd.error ?? cmd.outcome),
      });
      await tx.printJobs.recordPrinterStatus(
        job.printerId,
        cmd.outcome === 'printed' ? null : (cmd.error ?? cmd.outcome),
        now,
      );
      const fields = {
        printJobId: jobId,
        orderId: job.orderId,
        productionTicketId: job.productionTicketId,
        printerId: job.printerId,
        outcome: cmd.outcome,
        status: next.status,
        attempts: next.attempts,
        possibleDuplicate: next.possibleDuplicate,
        reroutedTo: next.reroutedToBackup ? next.printerId : undefined,
        error: cmd.error ?? undefined,
      };
      log.add(next.status === 'dead' ? 'print_job.dead' : 'print_job.result', fields);
      if (next.status === 'dead') {
        await tx.devices.appendEvent(job.printerId, 'print_job_dead', {
          printJobId: jobId,
          error: cmd.error ?? null,
        });
      }
      return next.status;
    });
    log.flush(this.deps.logger);
    return { status };
  }
}

/** Manager puts a failed/dead job back in the queue. Audited. */
export class RetryPrintJob {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, jobId: string): Promise<{ status: string }> {
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    const status = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const job = await tx.printJobs.findForUpdate(jobId);
      if (!job) throw new DomainError('NOT_FOUND', 'Print job not found', { jobId });
      authorize(ctx.principal, 'print.manage', job.branchId);
      if (job.status !== 'dead' && job.status !== 'failed') {
        throw new DomainError('INVALID_TRANSITION', `A ${job.status} print job cannot be retried`, { jobId });
      }
      await tx.printJobs.update(jobId, {
        status: 'pending',
        maxAttempts: job.attempts + PRINT_RETRY_POLICY.maxAttempts,
        nextAttemptAt: now,
        deadAt: null,
      });
      await tx.audit.append({
        branchId: job.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'print_job.retry',
        entityType: 'print_job',
        entityId: jobId,
        before: { status: job.status, attempts: job.attempts },
        after: { status: 'pending' },
        correlationId: ctx.correlationId,
      });
      log.add('print_job.retry_requested', { printJobId: jobId, orderId: job.orderId });
      return 'pending';
    });
    log.flush(this.deps.logger);
    return { status };
  }
}

export class GetPrintQueue {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, branchId: string): Promise<PrintQueueView> {
    authorize(ctx.principal, 'print.manage', branchId);
    return this.deps.uow.run(ctx.principal.restaurantId, (tx) => tx.read.printQueue(branchId));
  }
}
