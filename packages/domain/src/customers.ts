import { DomainError } from './errors';

/**
 * A customer's telephone number in one canonical form, so "024 123 4567", "0241234567",
 * "+233 24 123 4567" and "233241234567" are the same customer. Ghanaian numbers are the
 * default; a number written with + or 00 keeps its own country code. Same rules as the
 * database function app.canonical_phone (migration 20260928000100).
 */
export function canonicalPhone(input: string): string | null {
  const raw = input.trim();
  const digits = raw.replace(/\D/g, '');
  if (/^233\d{9}$/.test(digits)) return `+${digits}`;
  if (/^0\d{9}$/.test(digits)) return `+233${digits.slice(1)}`;
  if (/^[2-5]\d{8}$/.test(digits)) return `+233${digits}`;
  if (/^(\+|00)/.test(raw)) {
    const intl = digits.replace(/^00/, '');
    if (intl.length >= 8 && intl.length <= 15) return `+${intl}`;
  }
  return null;
}

/** canonicalPhone, or a VALIDATION_FAILED error a person can act on. */
export function requirePhone(input: string | null | undefined): string {
  const phone = input ? canonicalPhone(input) : null;
  if (!input?.trim()) throw new DomainError('VALIDATION_FAILED', 'Enter the customer’s telephone number');
  if (!phone)
    throw new DomainError('VALIDATION_FAILED', 'Enter a valid telephone number, e.g. 024 123 4567', {
      field: 'phone',
    });
  return phone;
}

/** How a canonical number is shown: Ghanaian numbers as 024 123 4567, others as stored. */
export function displayPhone(phone: string): string {
  const m = /^\+233(\d{2})(\d{3})(\d{4})$/.exec(phone);
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : phone;
}
