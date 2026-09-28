import type { ReportFormat, ReportValue, ReportView } from '@rp/contracts';

/** Minor units → "1,234.50" (no currency; the column header or label names it). */
export function money(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minor));
  return `${sign}${Math.trunc(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export function quantity(v: number): string {
  return Number(v.toFixed(3)).toLocaleString('en-US', { maximumFractionDigits: 3 });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "28 Sep 2026" for a business day (YYYY-MM-DD). Month names are fixed, not left to the runtime's locale data. */
export function day(v: string): string {
  const [y, m, d] = v.slice(0, 10).split('-').map(Number);
  return `${pad(d!)} ${MONTHS[m! - 1]} ${y}`;
}

/** "28 Sep 2026, 14:05" in the restaurant's timezone. */
export function dateTime(iso: string, timeZone: string): string {
  const p = localParts(iso, timeZone);
  return `${pad(p.d)} ${MONTHS[p.mo - 1]} ${p.y}, ${pad(p.h)}:${pad(p.mi)}`;
}

/** Wall-clock parts of an instant in a timezone (for spreadsheet dates, which have no timezone). */
export function localParts(
  iso: string,
  timeZone: string,
): { y: number; mo: number; d: number; h: number; mi: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute') };
}

/** A value as display text, e.g. for PDF cells and summary lines. */
export function display(v: ReportValue, format: ReportFormat, view: Pick<ReportView, 'timezone'>): string {
  if (v === null || v === '') return '';
  if (
    typeof v === 'string' &&
    format !== 'text' &&
    format !== 'date' &&
    format !== 'datetime' &&
    Number.isNaN(Number(v))
  )
    return v;
  switch (format) {
    case 'money':
      return money(Number(v));
    case 'int':
      return Math.round(Number(v)).toLocaleString('en-US');
    case 'qty':
      return quantity(Number(v));
    case 'percent':
      return `${(Number(v) / 100).toFixed(2)}%`;
    case 'date':
      return day(String(v));
    case 'datetime':
      return dateTime(String(v), view.timezone);
    default:
      return String(v);
  }
}

/** Column header with the currency for money columns, e.g. "Net sales (GHS)". */
export function header(label: string, format: ReportFormat, currency: string): string {
  return format === 'money' ? `${label} (${currency})` : label;
}

/** A safe, descriptive file name, e.g. myfood-end-of-day-2026-09-28.xlsx. */
export function fileName(view: ReportView, ext: string): string {
  const slug = view.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const period =
    view.period.from === view.period.to ? view.period.from : `${view.period.from}_to_${view.period.to}`;
  return `myfood-${slug}-${period}.${ext}`;
}
