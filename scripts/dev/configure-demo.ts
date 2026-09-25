/**
 * DEV ONLY: configures a freshly created restaurant for the milestone
 * scenarios, entirely through the restaurant-facing admin API (as the owner),
 * i.e. the same validated, permission-checked, audited path the admin screen uses.
 * Staff accounts created here are written to .dev-accounts.json (gitignored).
 *
 *   OWNER_EMAIL=... OWNER_PASSWORD=... pnpm dev:configure-demo
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { ApiClient } from '@rp/client-core';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k}`);
  return v;
};
const SUPABASE_URL = env('SUPABASE_URL');
const ANON = env('SUPABASE_ANON_KEY');
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:8787';

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { access_token?: string; msg?: string };
  if (!body.access_token) throw new Error(`Sign-in failed for ${email}: ${body.msg ?? res.status}`);
  return body.access_token;
}

const token = await signIn(env('OWNER_EMAIL'), env('OWNER_PASSWORD'));
const api = new ApiClient({ baseUrl: API_URL, getAccessToken: async () => token });
const me = await api.me();
const branchId = me.branches[0]!.id;
const save = async (entity: Parameters<ApiClient['saveConfig']>[0], record: Record<string, unknown>) =>
  (await api.saveConfig(entity, record)).id;

// Operational areas: hall pays after eating; takeaway pays before handover.
const hall = await save('area', {
  branchId,
  name: 'Hall',
  channel: 'dine_in',
  requiresTable: true,
  paymentPolicy: 'pay_after_fulfillment',
  sortOrder: 1,
});
await save('area', {
  branchId,
  name: 'Takeaway',
  channel: 'takeaway',
  paymentPolicy: 'pay_before_fulfillment',
  sortOrder: 2,
});
for (let n = 1; n <= 12; n++)
  await save('table', { branchId, areaId: hall, label: String(n), capacity: n <= 6 ? 4 : 6 });

// Stations
const station = (name: string, code: string, sortOrder: number) =>
  save('station', { branchId, name, code, sortOrder, targetPrepSeconds: 900 });
const kit = await station('Main Kitchen', 'KIT', 1);
const grl = await station('Grill', 'GRL', 2);
const pas = await station('Pastry', 'PAS', 3);
const drk = await station('Drinks', 'DRK', 4);

// Devices: one print agent drives all printers. Addresses are placeholders until the real LAN is known.
const agent = await save('device', { branchId, kind: 'print_agent', name: 'PRINT-AGENT-01' });
const printerHost = process.env.DEMO_PRINTER_HOST ?? '192.168.1';
const printer = (name: string, lastOctet: number) =>
  save('device', {
    branchId,
    kind: 'printer',
    name,
    printer: { address: `${printerHost}.${lastOctet}:9100`, agentDeviceId: agent },
  });
const pKit = await printer('KITCHEN-PRINTER-01', 51);
const pGrl = await printer('GRILL-PRINTER-01', 52);
const pPas = await printer('PASTRY-PRINTER-01', 53);
const pDrk = await printer('DRINKS-PRINTER-01', 54);
const pCake = await printer('PASTRY-PRINTER-02', 55);
const pReceipt = await printer('RECEIPT-PRINTER-01', 60);
const kds = (name: string, stationId: string) => save('device', { branchId, kind: 'kds', name, stationId });
const kKit = await kds('KITCHEN-01', kit);
const kGrl = await kds('GRILL-01', grl);
const kPas = await kds('PASTRY-01', pas);
const kDrk = await kds('DRINKS-01', drk);
await save('device', { branchId, kind: 'pos', name: 'POS-01', receiptPrinterId: pReceipt });
await save('device', { branchId, kind: 'customer_display', name: 'CUSTOMER-DISPLAY-01' });
for (const [stationId, printerId, kdsId] of [
  [kit, pKit, kKit],
  [grl, pGrl, kGrl],
  [pas, pPas, kPas],
  [drk, pDrk, kDrk],
]) {
  await save('stationOutput', { stationId, deviceId: printerId, role: 'primary' });
  await save('stationOutput', { stationId, deviceId: kdsId, role: 'primary' });
}

// Menu
const tax = await save('taxRate', {
  name: 'VAT (configure with your accountant)',
  rateBp: 1500,
  isInclusive: true,
});
const cat = (name: string, parentId: string | null = null, sortOrder = 0) =>
  save('category', { name, parentId, sortOrder });
const food = await cat('Food', null, 1);
const rice = await cat('Rice Dishes', food);
const grills = await cat('Grills', food);
const sandwiches = await cat('Sandwiches', food);
const pastries = await cat('Pastries', null, 2);
const cakes = await cat('Cakes', pastries);
const drinks = await cat('Drinks', null, 3);
const product = (name: string, categoryId: string, price: number, kitchenName?: string) =>
  save('product', {
    name,
    categoryId,
    basePrice: price,
    kitchenName: kitchenName ?? null,
    taxRateIds: [tax],
  });
await product('Jollof Rice', rice, 4500, 'JOLLOF');
await product('Fried Rice', rice, 4000);
await product('Grilled Chicken', grills, 6000);
await product('Chicken Sandwich', sandwiches, 3500);
await product('Meat Pie', pastries, 1500);
const cake = await product('Birthday Cake', cakes, 25000);
await product('Coke', drinks, 1000);
await product('Malt', drinks, 1200);

// Routing: category rules, a default, and the cake override with a second printer.
await save('routingRule', { branchId, match: 'category', categoryId: food, stationId: kit });
await save('routingRule', { branchId, match: 'category', categoryId: grills, stationId: grl });
await save('routingRule', { branchId, match: 'category', categoryId: pastries, stationId: pas });
await save('routingRule', { branchId, match: 'category', categoryId: drinks, stationId: drk });
await save('routingRule', { branchId, match: 'default', stationId: kit });
await save('routingRule', {
  branchId,
  match: 'product',
  productId: cake,
  stationId: pas,
  extraPrinterIds: [pCake],
});

// Staff
const config = await api.configuration();
const role = (name: string) => config.roles.find((r) => r.name === name)!.id;
const accounts: Record<string, { email: string; password: string }> = {};
const domain = process.env.DEMO_STAFF_DOMAIN ?? 'staff.example.com';
for (const [key, displayName, roleName] of [
  ['cashier', 'Kofi (Cashier)', 'Cashier'],
  ['waiter', 'Esi (Waiter)', 'Waiter'],
  ['kitchen', 'Yaw (Kitchen)', 'Kitchen'],
  ['manager', 'Ama (Manager)', 'Manager'],
] as const) {
  const email = `${key}.${randomBytes(3).toString('hex')}@${domain}`;
  const password = randomBytes(12).toString('base64url');
  await api.createStaff({ displayName, email, password, roleIds: [role(roleName)], branchId });
  accounts[key] = { email, password };
}
accounts.owner = { email: env('OWNER_EMAIL'), password: env('OWNER_PASSWORD') };
writeFileSync(
  process.env.ACCOUNTS_FILE ?? '.dev-accounts.json',
  `${JSON.stringify({ restaurant: me.restaurant, branchId, accounts }, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    configured: true,
    restaurant: me.restaurant.name,
    branchId,
    accountsWrittenTo: process.env.ACCOUNTS_FILE ?? '.dev-accounts.json',
  }),
);
