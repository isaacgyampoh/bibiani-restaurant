import { createHmac } from 'node:crypto';
import type { PinHasher } from '@rp/application';

/**
 * PIN digest = HMAC-SHA256(pepper, restaurantId:pin). The pepper is a server-only secret
 * (PIN_PEPPER), so the stored digests cannot be reversed from a database copy alone.
 */
export class HmacPinHasher implements PinHasher {
  constructor(private readonly pepper: string) {
    if (pepper.length < 32) throw new Error('PIN_PEPPER must be at least 32 characters');
  }
  lookup(restaurantId: string, pin: string): string {
    return createHmac('sha256', this.pepper).update(`${restaurantId}:${pin}`).digest('hex');
  }
}
