import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Outcome = 'printed' | 'failed_before_send' | 'failed_after_send';

export interface JournalEntry {
  jobId: string;
  claimId: string;
  stage: 'sending' | 'result' | 'reported';
  outcome?: Outcome;
  error?: string | null;
  at: string;
}

/**
 * Local append-only record of what this agent did to each job. It survives
 * restarts so that:
 *  - a crash mid-send is reported as "failed after send" (possible duplicate),
 *  - a job already printed is never printed again just because the result
 *    could not be reported before the lease expired,
 *  - results are re-reported after network outages.
 * The server stays authoritative; this only prevents the agent repeating itself.
 */
export class PrintJournal {
  private readonly latest = new Map<string, JournalEntry>();

  constructor(private readonly file: string | null) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as JournalEntry;
          this.latest.set(e.jobId, e);
        } catch {
          // A torn last line after power loss: ignore it, earlier lines are intact.
        }
      }
      this.compact();
    }
  }

  private write(entry: JournalEntry): void {
    this.latest.set(entry.jobId, entry);
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
  }

  sending(jobId: string, claimId: string): void {
    this.write({ jobId, claimId, stage: 'sending', at: new Date().toISOString() });
  }

  result(jobId: string, claimId: string, outcome: Outcome, error: string | null): void {
    this.write({ jobId, claimId, stage: 'result', outcome, error, at: new Date().toISOString() });
  }

  reported(jobId: string): void {
    const prev = this.latest.get(jobId);
    this.write({ ...(prev ?? { jobId, claimId: '' }), stage: 'reported', at: new Date().toISOString() });
  }

  /** Did this agent already print this job (even if the server has not heard yet)? */
  alreadyPrinted(jobId: string): boolean {
    return this.latest.get(jobId)?.outcome === 'printed';
  }

  /** Results not yet accepted by the server, including sends interrupted by a crash. */
  unreported(): JournalEntry[] {
    return [...this.latest.values()]
      .filter((e) => e.stage !== 'reported')
      .map((e) =>
        e.stage === 'sending'
          ? {
              ...e,
              stage: 'result' as const,
              outcome: 'failed_after_send' as const,
              error: 'agent restarted during print',
            }
          : e,
      );
  }

  /** Keeps the file small: only the latest state per job, dropping reported jobs older than a day. */
  compact(): void {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const [id, e] of this.latest)
      if (e.stage === 'reported' && Date.parse(e.at) < cutoff) this.latest.delete(id);
    if (this.file)
      writeFileSync(this.file, [...this.latest.values()].map((e) => `${JSON.stringify(e)}\n`).join(''));
  }
}
