import { randomUUID } from 'node:crypto';
import type { SubmitOrderCommand } from '@rp/contracts';

export const uuid = () => randomUUID();

export function line(
  productId: string,
  quantity: number,
  extra: Partial<SubmitOrderCommand['items'][number]> = {},
) {
  return { id: uuid(), productId, quantity, modifierIds: [], notes: null, ...extra };
}
