/**
 * Creates the client DEMO restaurant, "Chefelisha Restaurant — Demo", in the ONE Supabase project, with a
 * real Supabase Auth demo login and realistic data (menu, stations, routing, staff, today's orders at
 * every stage, payments). It is a separate restaurant, isolated by RLS from the real Chefelisha Restaurant.
 *
 * Everything after the restaurant row is created through the restaurant-facing API as the demo
 * account: validated, permission-checked and audited like any real use.
 *
 *   PLATFORM_DATABASE_URL=... API_URL=https://bibiani-restaurant.vercel.app \
 *     tsx --env-file=.env.production scripts/demo/seed-demo.ts
 *
 * The demo password is generated here and written ONLY to .demo-credentials.json (gitignored; the
 * repository is public). Refuses to run if the demo restaurant already exists.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { ApiClient } from '@rp/client-core';
import type { OrderView } from '@rp/contracts';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k}`);
  return v;
};
const SUPABASE_URL = need('SUPABASE_URL');
const ANON = need('SUPABASE_ANON_KEY');
const API_URL = need('API_URL');
const EMAIL = process.env.DEMO_EMAIL ?? 'demo@restaurant.test';
const SLUG = process.env.DEMO_SLUG ?? 'bibiani-demo';
// Readable but strong: 4 groups of 5 from an unambiguous alphabet (~100 bits).
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PASSWORD = Array.from({ length: 4 }, () =>
  Array.from(randomBytes(5), (b) => ALPHABET[b % ALPHABET.length]).join(''),
).join('-');

// 1. Restaurant, roles and the demo owner login (platform operation).
execFileSync(
  'npx',
  [
    'tsx',
    'scripts/platform/create-restaurant.ts',
    '--name',
    'Chefelisha Restaurant — Demo',
    '--slug',
    SLUG,
    '--owner-email',
    EMAIL,
    '--owner-name',
    'Demo Manager',
    '--start',
    '101',
  ],
  { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, OWNER_PASSWORD: PASSWORD } },
);
writeFileSync(
  '.demo-credentials.json',
  `${JSON.stringify({ url: API_URL, email: EMAIL, password: PASSWORD, restaurant: 'Chefelisha Restaurant — Demo' }, null, 2)}\n`,
  { mode: 0o600 },
);

const token = async () => {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`Demo sign-in failed (${res.status})`);
  return body.access_token;
};
let cached: { value: string; at: number } | null = null;
const api = new ApiClient({
  baseUrl: API_URL,
  getAccessToken: async () => {
    if (!cached || Date.now() - cached.at > 30 * 60_000) cached = { value: await token(), at: Date.now() };
    return cached.value;
  },
});
const me = await api.me();
const branchId = me.branches[0]!.id;
const save = async (entity: Parameters<ApiClient['saveConfig']>[0], record: Record<string, unknown>) =>
  (await api.saveConfig(entity, record)).id;

// 2. Floor: hall pays after eating, takeaway pays before handover, outdoor terrace.
const hall = await save('area', {
  branchId,
  name: 'Main Hall',
  channel: 'dine_in',
  requiresTable: true,
  paymentPolicy: 'pay_after_fulfillment',
  sortOrder: 1,
});
const terrace = await save('area', {
  branchId,
  name: 'Terrace',
  channel: 'dine_in',
  requiresTable: true,
  paymentPolicy: 'pay_after_fulfillment',
  sortOrder: 2,
});
const takeaway = await save('area', {
  branchId,
  name: 'Takeaway',
  channel: 'takeaway',
  requiresCustomerName: true,
  paymentPolicy: 'pay_before_fulfillment',
  sortOrder: 3,
});
const tables: Record<string, string> = {};
for (let n = 1; n <= 15; n++)
  tables[String(n)] = await save('table', {
    branchId,
    areaId: hall,
    label: String(n),
    capacity: n <= 8 ? 4 : n <= 12 ? 6 : 8,
  });
for (const label of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'])
  tables[label] = await save('table', { branchId, areaId: terrace, label, capacity: 4 });

// 3. Stations, each with its kitchen screen; POS terminals; customer display.
const station = async (name: string, code: string, sortOrder: number, targetPrepSeconds: number) => {
  const id = await save('station', { branchId, name, code, sortOrder, targetPrepSeconds });
  const kds = await save('device', { branchId, kind: 'kds', name: `${code}-KDS-01`, stationId: id });
  await save('stationOutput', { stationId: id, deviceId: kds, role: 'primary' });
  return id;
};
const kitchen = await station('Main Kitchen', 'KITCHEN', 1, 900);
const grill = await station('Grill', 'GRILL', 2, 1200);
const pastry = await station('Pastry', 'PASTRY', 3, 600);
const drinks = await station('Drinks', 'DRINKS', 4, 300);
for (const name of ['POS-01 Main Hall', 'POS-02 Reception', 'POS-03 Takeaway'])
  await save('device', { branchId, kind: 'pos', name });
await save('device', { branchId, kind: 'customer_display', name: 'CUSTOMER-DISPLAY-01' });

// 4. Menu (GHS, prices in pesewas). Tax is a demo placeholder, clearly named.
const vat = await save('taxRate', { name: 'VAT & levies (demo rate)', rateBp: 2190, isInclusive: true });
const cat = (name: string, sortOrder: number) => save('category', { name, sortOrder });
const mains = await cat('Main Meals', 1);
const grills = await cat('Grills', 2);
const sides = await cat('Sides', 3);
const pastries = await cat('Pastries & Desserts', 4);
const soft = await cat('Drinks', 5);

const group = async (name: string, maxSelect: number | null, options: [string, number][]) => {
  const id = await save('modifierGroup', { name, minSelect: 0, maxSelect });
  for (const [i, [opt, priceDelta]] of options.entries())
    await save('modifier', { groupId: id, name: opt, priceDelta, sortOrder: i });
  return id;
};
const spice = await group('Spice level', 1, [
  ['Mild', 0],
  ['Medium', 0],
  ['Extra spicy', 0],
]);
const protein = await group('Add protein', 2, [
  ['Extra chicken', 1500],
  ['Boiled egg', 300],
  ['Fried fish', 2000],
]);
const sideOptions = await group('Side swap', 1, [
  ['Plain rice', 0],
  ['Kelewele', 500],
  ['Fried yam', 500],
]);
const drinkOptions = await group('Drink options', 2, [
  ['No ice', 0],
  ['Extra cold', 0],
]);
const cakeOptions = await group('Cake options', 1, [
  ['Birthday message', 0],
  ['Add candle', 200],
]);

const products: Record<string, string> = {};
const product = async (
  name: string,
  categoryId: string,
  price: number,
  modifierGroupIds: string[] = [],
  kitchenName?: string,
) => {
  products[name] = await save('product', {
    name,
    categoryId,
    basePrice: price,
    kitchenName: kitchenName ?? null,
    taxRateIds: [vat],
    modifierGroupIds,
  });
};
await product('Jollof Rice', mains, 4500, [spice, protein], 'JOLLOF');
await product('Fried Rice', mains, 4500, [spice, protein]);
await product('Waakye', mains, 4000, [protein], 'WAAKYE');
await product('Banku & Tilapia', grills, 9500, [spice], 'BANKU TILAPIA');
await product('Grilled Chicken', grills, 5500, [spice, sideOptions], 'CHICKEN');
await product('Fried Fish', grills, 6000, [spice, sideOptions], 'FRIED FISH');
await product('Beef Kebab', grills, 3000, [spice], 'KEBAB');
await product('Kelewele', sides, 1500);
await product('Fried Yam', sides, 1500);
await product('Meat Pie', pastries, 1500);
await product('Chocolate Cake', pastries, 3500, [cakeOptions], 'CHOC CAKE');
await product('Coconut Tart', pastries, 2000);
await product('Coke', soft, 1000, [drinkOptions]);
await product('Malt', soft, 1200, [drinkOptions]);
await product('Sobolo', soft, 1500, [drinkOptions]);
await product('Fresh Pineapple Juice', soft, 2000, [drinkOptions], 'PINEAPPLE JUICE');
await product('Bottled Water', soft, 500);

// 5. Routing: by category, a default, and one product override (kebab is a grill item sold as a side).
await save('routingRule', { branchId, match: 'category', categoryId: mains, stationId: kitchen });
await save('routingRule', { branchId, match: 'category', categoryId: sides, stationId: kitchen });
await save('routingRule', { branchId, match: 'category', categoryId: grills, stationId: grill });
await save('routingRule', { branchId, match: 'category', categoryId: pastries, stationId: pastry });
await save('routingRule', { branchId, match: 'category', categoryId: soft, stationId: drinks });
await save('routingRule', { branchId, match: 'default', stationId: kitchen });

// 6. Staff (their logins get random passwords that are never stored: they are shown in the Staff
//    screen as the team; the demo account is the one used to present).
const config = await api.configuration();
const role = (name: string) => config.roles.find((r) => r.name === name)!.id;
for (const [displayName, roleName] of [
  ['Kofi Mensah', 'Cashier'],
  ['Akosua Boateng', 'Cashier'],
  ['Esi Owusu', 'Waiter'],
  ['Kwabena Asante', 'Waiter'],
  ['Yaw Darko', 'Kitchen'],
  ['Abena Sarpong', 'Kitchen'],
  ['Ama Agyeman', 'Manager'],
] as const) {
  await api.createStaff({
    displayName,
    email: `${displayName.split(' ')[0]!.toLowerCase()}@demo.chefelisha.test`,
    password: randomBytes(24).toString('base64url'),
    roleIds: [role(roleName)],
    branchId,
  });
}

// 7. Today's service: orders at every stage, so every screen has something real to show.
const item = (name: string, quantity = 1, modifiers: string[] = []) => ({
  id: randomUUID(),
  productId: products[name]!,
  quantity,
  modifierIds: modifiers.map((m) => {
    const found = config.modifiers.find((x) => x.name === m);
    if (!found) throw new Error(`Unknown modifier ${m}`);
    return String(found.id);
  }),
  notes: null,
});
const order = (
  areaId: string,
  items: ReturnType<typeof item>[],
  extra: { tableId?: string; customerName?: string } = {},
) =>
  api.submitOrder({
    orderId: randomUUID(),
    branchId,
    areaId,
    tableId: extra.tableId ?? null,
    customerName: extra.customerName ?? null,
    items,
    send: { submissionId: randomUUID() },
  } as Parameters<ApiClient['submitOrder']>[0]);
const ticketsOf = async (o: OrderView) => (await api.getOrder(o.id)).tickets;
const act = async (o: OrderView, action: 'start' | 'ready', stationName?: string) => {
  for (const t of await ticketsOf(o)) {
    if (stationName && t.stationName !== stationName) continue;
    await api.ticketAction(t.id, { action });
  }
};
const pay = (o: OrderView, method: 'cash' | 'momo' | 'card', amount: number, reference?: string) =>
  api.recordPayment(o.id, {
    paymentId: randomUUID(),
    method,
    amount,
    reference: reference ?? null,
    tendered: null,
  } as Parameters<ApiClient['recordPayment']>[1]);

// Completed and paid (sales for the dashboard and reports).
const done1 = await order(hall, [item('Jollof Rice', 2, ['Extra chicken']), item('Coke', 2)], {
  tableId: tables['3'],
});
await api.markReady(done1.id);
await api.fulfilOrder(done1.id);
await pay(done1, 'cash', (await api.getOrder(done1.id)).balanceDue);
const done2 = await order(takeaway, [item('Waakye', 1, ['Boiled egg']), item('Sobolo')], {
  customerName: 'Nana',
});
await pay(done2, 'momo', done2.grandTotal, 'MTN-0244-889120');
await api.markReady(done2.id);
await api.fulfilOrder(done2.id);
const done3 = await order(terrace, [item('Banku & Tilapia', 2, ['Extra spicy']), item('Malt', 2)], {
  tableId: tables.T2,
});
await api.markReady(done3.id);
await api.fulfilOrder(done3.id);
const due3 = (await api.getOrder(done3.id)).balanceDue;
await pay(done3, 'cash', Math.round(due3 / 2));
await pay(done3, 'card', due3 - Math.round(due3 / 2), 'CARD-4417');
const done4 = await order(takeaway, [item('Fried Rice'), item('Grilled Chicken'), item('Bottled Water', 2)], {
  customerName: 'Kwesi',
});
await pay(done4, 'card', done4.grandTotal, 'CARD-9021');
await api.markReady(done4.id);
await api.fulfilOrder(done4.id);

// Ready for collection / to serve.
const ready1 = await order(takeaway, [item('Meat Pie', 3), item('Fresh Pineapple Juice')], {
  customerName: 'Adwoa',
});
await pay(ready1, 'momo', ready1.grandTotal, 'VODA-0503-117733');
await api.markReady(ready1.id);
const ready2 = await order(hall, [item('Fried Fish', 1, ['Kelewele']), item('Coke')], {
  tableId: tables['7'],
});
await api.markReady(ready2.id);

// Partly ready: the supervisor's "3/4 ready" situation.
const partial = await order(
  hall,
  [
    item('Jollof Rice', 1, ['Medium']),
    item('Grilled Chicken', 1, ['Plain rice']),
    item('Chocolate Cake', 1, ['Add candle']),
    item('Malt', 2, ['No ice']),
  ],
  { tableId: tables['9'] },
);
await act(partial, 'start');
await act(partial, 'ready', 'Main Kitchen');
await act(partial, 'ready', 'Pastry');
await act(partial, 'ready', 'Drinks');

// Cooking now.
const cooking = await order(
  terrace,
  [item('Beef Kebab', 4, ['Extra spicy']), item('Kelewele', 2), item('Malt', 4)],
  {
    tableId: tables.T4,
  },
);
await act(cooking, 'start');

// Just sent (new tickets).
await order(hall, [item('Waakye', 2, ['Fried fish']), item('Sobolo', 2)], { tableId: tables['5'] });
await order(takeaway, [item('Jollof Rice', 1, ['Extra spicy', 'Extra chicken']), item('Coke')], {
  customerName: 'Yaa',
});

console.log(
  JSON.stringify({
    seeded: true,
    restaurant: 'Chefelisha Restaurant — Demo',
    login: EMAIL,
    credentialsFile: '.demo-credentials.json',
    products: Object.keys(products).length,
    tables: Object.keys(tables).length,
  }),
);
