import type { PrintJobStatus } from './enums';

/**
 * Printing guarantee: AT-LEAST-ONCE with visible duplicate marking.
 * ESC/POS printers cannot reliably confirm a print, so when a failure happens
 * after bytes may already have reached the printer, the retry is marked
 * "POSSIBLE DUPLICATE" instead of being dropped. A missing kitchen ticket is
 * worse than a clearly marked extra one.
 */
export const PRINT_RETRY_POLICY = {
  backoffSeconds: [2, 5, 15, 30, 60] as readonly number[],
  maxAttempts: 8,
  rerouteToBackupAfterAttempts: 3,
  leaseSeconds: 30,
} as const;

export const PRINT_OUTCOMES = [
  'printed',
  'failed_before_send',
  'failed_after_send',
  'lease_expired',
] as const;
export type PrintOutcome = (typeof PRINT_OUTCOMES)[number];

export interface PrintJobRetryState {
  status: PrintJobStatus;
  attempts: number;
  maxAttempts: number;
  printerId: string;
  originalPrinterId: string;
  possibleDuplicate: boolean;
}

export interface PrintJobTransition {
  status: PrintJobStatus;
  attempts: number;
  printerId: string;
  possibleDuplicate: boolean;
  nextAttemptAt: Date | null;
  printedAt: Date | null;
  deadAt: Date | null;
  reroutedToBackup: boolean;
}

export function applyPrintOutcome(
  job: PrintJobRetryState,
  outcome: PrintOutcome,
  now: Date,
  backupPrinterId: string | null,
): PrintJobTransition {
  if (outcome === 'printed') {
    return {
      status: 'printed',
      attempts: job.attempts + 1,
      printerId: job.printerId,
      possibleDuplicate: job.possibleDuplicate,
      nextAttemptAt: null,
      printedAt: now,
      deadAt: null,
      reroutedToBackup: false,
    };
  }

  const attempts = job.attempts + 1;
  const possibleDuplicate = job.possibleDuplicate || outcome !== 'failed_before_send';
  const reroute =
    backupPrinterId !== null &&
    job.printerId === job.originalPrinterId &&
    attempts >= PRINT_RETRY_POLICY.rerouteToBackupAfterAttempts;
  const printerId = reroute ? backupPrinterId : job.printerId;

  if (attempts >= job.maxAttempts) {
    return {
      status: 'dead',
      attempts,
      printerId,
      possibleDuplicate,
      nextAttemptAt: null,
      printedAt: null,
      deadAt: now,
      reroutedToBackup: false,
    };
  }

  const schedule = PRINT_RETRY_POLICY.backoffSeconds;
  const delay = reroute ? 0 : (schedule[Math.min(attempts - 1, schedule.length - 1)] ?? 60);
  return {
    status: 'failed',
    attempts,
    printerId,
    possibleDuplicate,
    nextAttemptAt: new Date(now.getTime() + delay * 1000),
    printedAt: null,
    deadAt: null,
    reroutedToBackup: reroute,
  };
}
