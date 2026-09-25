import { PERMISSIONS, type Permission } from './enums';

/**
 * Starting roles created for every new restaurant. Owners can edit them later;
 * the backend always checks permissions, the UI only hides what is not allowed.
 */
export const ROLE_TEMPLATES: Record<string, readonly Permission[]> = {
  Owner: PERMISSIONS,
  Manager: PERMISSIONS.filter((p) => p !== 'staff.manage'),
  Cashier: ['order.create', 'order.send', 'order.view', 'order.fulfil', 'payment.record', 'receipt.print'],
  Waiter: ['order.create', 'order.send', 'order.view', 'order.fulfil', 'receipt.print'],
  Kitchen: ['kitchen.operate', 'order.view'],
  Supervisor: ['order.view', 'order.fulfil', 'kitchen.operate', 'receipt.print', 'reports.view'],
  'Inventory Manager': ['inventory.manage', 'stock.count', 'reports.view', 'order.view'],
};
