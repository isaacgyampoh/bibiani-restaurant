import { businessDay } from './business-day';
import { DomainError } from './errors';

export type ReportPreset = 'today' | 'yesterday' | 'this_week' | 'this_month' | 'last_month' | 'custom';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * A report period as restaurant business days (inclusive), resolved in the branch's timezone
 * and business-day cutoff, never in UTC: "today" at 01:00 with a 04:00 cutoff is still yesterday's
 * trading day. Weeks start on Monday.
 */
export function resolvePeriod(
  preset: ReportPreset,
  now: Date,
  timeZone: string,
  cutoff: string,
  custom?: { from?: string | null; to?: string | null },
): { from: string; to: string } {
  const today = businessDay(now, timeZone, cutoff);
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case 'this_week': {
      const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
      return { from: addDays(today, -dow), to: today };
    }
    case 'this_month':
      return { from: `${today.slice(0, 8)}01`, to: today };
    case 'last_month': {
      const first = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
      first.setUTCMonth(first.getUTCMonth() - 1);
      const from = first.toISOString().slice(0, 10);
      return { from, to: addDays(`${today.slice(0, 8)}01`, -1) };
    }
    case 'custom': {
      const from = custom?.from ?? '';
      const to = custom?.to ?? '';
      if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)))
        throw new DomainError('VALIDATION_FAILED', 'Choose a valid date range');
      if (from > to) throw new DomainError('VALIDATION_FAILED', 'The start date is after the end date');
      if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366)
        throw new DomainError('VALIDATION_FAILED', 'Choose at most one year');
      return { from, to };
    }
  }
}

/** "01 September 2026 — 30 September 2026", or one day when from = to. */
export function describePeriod(from: string, to: string): string {
  const f = (d: string) =>
    new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${d}T00:00:00Z`));
  return from === to ? f(from) : `${f(from)} — ${f(to)}`;
}
