import { DomainError } from './errors';

/**
 * Staff PIN rules. A PIN only unlocks a staff session on a REGISTERED till (a paired POS device):
 * a short PIN is never a credential on its own on the open internet.
 */
export const PIN_MIN = 4;
export const PIN_MAX = 6;

export function assertAcceptablePin(pin: string): void {
  if (!/^\d+$/.test(pin) || pin.length < PIN_MIN || pin.length > PIN_MAX)
    throw new DomainError('VALIDATION_FAILED', `A PIN is ${PIN_MIN} to ${PIN_MAX} digits`, { field: 'pin' });
  if (/^(\d)\1+$/.test(pin))
    throw new DomainError('VALIDATION_FAILED', 'Choose a PIN that is not the same digit repeated', {
      field: 'pin',
    });
  const digits = [...pin].map(Number);
  const step = digits[1]! - digits[0]!;
  if (Math.abs(step) === 1 && digits.every((d, i) => i === 0 || d - digits[i - 1]! === step))
    throw new DomainError('VALIDATION_FAILED', 'Choose a PIN that is not a simple sequence like 1234', {
      field: 'pin',
    });
}

/** Failed attempts allowed per till, and per restaurant, inside the window before PIN sign-in locks. */
export const PIN_POLICY = {
  windowSeconds: 10 * 60,
  maxFailuresPerDevice: 5,
  maxFailuresPerRestaurant: 30,
  lockSeconds: 10 * 60,
} as const;

/**
 * Lockout decision from recent FAILED attempts (newest first, within the window). Returns the
 * moment sign-in reopens, or null when attempts are allowed.
 */
export function pinLockedUntil(
  deviceFailures: Date[],
  restaurantFailures: Date[],
  now: Date,
): { until: Date; scope: 'device' | 'restaurant' } | null {
  const check = (failures: Date[], max: number, scope: 'device' | 'restaurant') => {
    if (failures.length < max) return null;
    // Locked from the max-th most recent failure for lockSeconds.
    const trigger = failures[max - 1]!;
    const until = new Date(
      Math.max(trigger.getTime(), failures[0]!.getTime()) + PIN_POLICY.lockSeconds * 1000,
    );
    return until > now ? { until, scope } : null;
  };
  return (
    check(restaurantFailures, PIN_POLICY.maxFailuresPerRestaurant, 'restaurant') ??
    check(deviceFailures, PIN_POLICY.maxFailuresPerDevice, 'device')
  );
}
