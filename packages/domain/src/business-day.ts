import { invariant } from './errors';

/**
 * The trading day a moment belongs to, in the branch's timezone. Moments
 * before the cutoff (e.g. 01:30 with a 04:00 cutoff) belong to the previous day.
 * Returns an ISO date string (YYYY-MM-DD).
 */
export function businessDay(instant: Date, timeZone: string, cutoff: string): string {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(cutoff);
  invariant(match, 'Invalid business day cutoff', { cutoff });
  const cutoffSeconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const localSeconds = get('hour') * 3600 + get('minute') * 60 + get('second');

  const day = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
  if (localSeconds < cutoffSeconds) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/** HH:MM in the branch timezone, for tickets and displays. */
export function localTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}
