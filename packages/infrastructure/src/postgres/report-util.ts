import { dateOrNull } from '../db/sql';
import { iso } from './util';

export const isoOf = (v: unknown) => iso(dateOrNull(v));
/** A date column as YYYY-MM-DD, whether the driver returned text or a Date. */
export const isoDay = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10);
