import { PERMISSIONS, type Permission } from './enums';

/**
 * Starting roles created for every new restaurant. Owners can edit them later;
 * the backend always checks permissions, the UI only hides what is not allowed.
 * Every role can take orders and send them to the kitchen (owner's decision, 2026-09-30).
 */
export const ROLE_TEMPLATES: Record<string, readonly Permission[]> = {
  Owner: PERMISSIONS,
  // Managers manage staff too (2026-09-30); only an Owner can give the Owner role or change an owner.
  Manager: PERMISSIONS,
  Cashier: [
    'order.create',
    'order.send',
    'order.view',
    'order.fulfil',
    'payment.record',
    'receipt.print',
    'customer.attach',
    'register.operate',
  ],
  Waiter: ['order.create', 'order.send', 'order.view', 'order.fulfil', 'receipt.print', 'customer.attach'],
  Kitchen: ['kitchen.operate', 'order.create', 'order.send', 'order.view', 'customer.attach'],
  Supervisor: [
    'order.create',
    'order.send',
    'order.view',
    'order.fulfil',
    'kitchen.operate',
    'receipt.print',
    'reports.view',
    'discount.apply',
    'customer.attach',
    'customer.view',
  ],
  'Inventory Manager': [
    'inventory.manage',
    'stock.count',
    'reports.view',
    'order.create',
    'order.send',
    'order.view',
    'customer.attach',
  ],
};
