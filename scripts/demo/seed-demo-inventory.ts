/**
 * Adds realistic STOCK to the demo restaurant (after scripts/demo/seed-demo.ts): stock items,
 * opening deliveries with invoice numbers, some wastage, recipes for the main dishes and drinks
 * (so new sales deduct stock), one approved stock count with explained variances and one count
 * in progress. Everything goes through the API as the demo account, so it is validated and audited.
 *
 *   API_URL=https://bibiani-restaurant.vercel.app tsx --env-file=.env.production scripts/demo/seed-demo-inventory.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ApiClient } from '@rp/client-core';

const creds = JSON.parse(readFileSync('.demo-credentials.json', 'utf8')) as {
  email: string;
  password: string;
};
const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: process.env.SUPABASE_ANON_KEY!, 'content-type': 'application/json' },
  body: JSON.stringify(creds),
});
const { access_token } = (await res.json()) as { access_token?: string };
if (!access_token) throw new Error('Demo sign-in failed');
const api = new ApiClient({ baseUrl: process.env.API_URL!, getAccessToken: async () => access_token });
const me = await api.me();
const branchId = me.branches[0]!.id;
if ((await api.inventory(branchId)).items.length > 0) throw new Error('Demo inventory already exists');

type Unit = 'kg' | 'l' | 'pcs' | 'bottle' | 'tray';
// name, category, unit, minimum, cost per unit (pesewas), opening delivery, invoice
const ITEMS: [string, string, Unit, number, number, number, string][] = [
  ['Jasmine rice', 'Dry goods', 'kg', 25, 2200, 60, 'INV-GH-1041'],
  ['Parboiled rice', 'Dry goods', 'kg', 15, 1900, 30, 'INV-GH-1041'],
  ['Chicken (whole legs)', 'Meat & fish', 'kg', 10, 6500, 24, 'INV-POUL-220'],
  ['Tilapia', 'Meat & fish', 'kg', 8, 7000, 12, 'INV-FISH-88'],
  ['Beef', 'Meat & fish', 'kg', 5, 9000, 4.5, 'INV-MEAT-51'],
  ['Vegetable oil', 'Dry goods', 'l', 10, 3200, 25, 'INV-GH-1041'],
  ['Tomatoes', 'Vegetables', 'kg', 8, 1500, 20, 'MKT-2509'],
  ['Onions', 'Vegetables', 'kg', 5, 1200, 12, 'MKT-2509'],
  ['Ripe plantain', 'Vegetables', 'pcs', 30, 250, 80, 'MKT-2509'],
  ['Beans (waakye)', 'Dry goods', 'kg', 5, 2400, 10, 'INV-GH-1041'],
  ['Eggs', 'Dairy & eggs', 'tray', 3, 6500, 6, 'INV-FARM-12'],
  ['Flour', 'Bakery', 'kg', 10, 1400, 25, 'INV-BAKE-7'],
  ['Chocolate cake (whole)', 'Bakery', 'pcs', 2, 18000, 4, 'INV-BAKE-7'],
  ['Coca-Cola 35cl', 'Drinks', 'bottle', 48, 450, 96, 'INV-BEV-310'],
  ['Malt 33cl', 'Drinks', 'bottle', 48, 600, 40, 'INV-BEV-310'],
  ['Sobolo (bulk)', 'Drinks', 'l', 10, 800, 18, 'INV-BEV-310'],
  ['Pineapple', 'Fruit', 'pcs', 10, 1500, 14, 'MKT-2509'],
  ['Bottled water 50cl', 'Drinks', 'bottle', 48, 200, 120, 'INV-BEV-310'],
];
const ids: Record<string, string> = {};
for (const [name, category, unit, min, cost, opening, invoice] of ITEMS) {
  const { id } = await api.saveInventoryItem({
    branchId,
    name,
    category,
    unit,
    minQuantity: min,
    unitCost: cost,
    isActive: true,
  });
  ids[name] = id;
  await api.recordStockMovement({
    movementId: randomUUID(),
    itemId: id,
    kind: 'receive',
    quantity: opening,
    reference: invoice,
    unitCost: cost,
  });
}
const waste = (name: string, quantity: number, reason: string) =>
  api.recordStockMovement({ movementId: randomUUID(), itemId: ids[name]!, kind: 'waste', quantity, reason });
await waste('Tomatoes', 2.5, 'Overripe, discarded');
await waste('Ripe plantain', 6, 'Spoiled');
await waste('Coca-Cola 35cl', 2, 'Broken bottles in delivery');

// Recipes: what ONE portion uses. New sales deduct these from stock.
const config = await api.configuration();
const product = (name: string) =>
  String((config.products as Record<string, unknown>[]).find((p) => p.name === name)!.id);
const recipe = (name: string, parts: [string, number][]) =>
  api.saveRecipe(product(name), {
    components: parts.map(([item, quantity]) => ({ itemId: ids[item]!, quantity })),
  });
await recipe('Jollof Rice', [
  ['Jasmine rice', 0.2],
  ['Vegetable oil', 0.03],
  ['Tomatoes', 0.1],
  ['Onions', 0.05],
]);
await recipe('Fried Rice', [
  ['Jasmine rice', 0.2],
  ['Vegetable oil', 0.04],
  ['Eggs', 0.03],
]);
await recipe('Waakye', [
  ['Parboiled rice', 0.15],
  ['Beans (waakye)', 0.08],
]);
await recipe('Grilled Chicken', [['Chicken (whole legs)', 0.35]]);
await recipe('Fried Fish', [
  ['Tilapia', 0.4],
  ['Vegetable oil', 0.05],
]);
await recipe('Banku & Tilapia', [['Tilapia', 0.5]]);
await recipe('Beef Kebab', [['Beef', 0.15]]);
await recipe('Kelewele', [
  ['Ripe plantain', 2],
  ['Vegetable oil', 0.03],
]);
await recipe('Chocolate Cake', [['Chocolate cake (whole)', 0.125]]);
await recipe('Meat Pie', [
  ['Flour', 0.08],
  ['Beef', 0.03],
]);
await recipe('Coke', [['Coca-Cola 35cl', 1]]);
await recipe('Malt', [['Malt 33cl', 1]]);
await recipe('Sobolo', [['Sobolo (bulk)', 0.35]]);
await recipe('Fresh Pineapple Juice', [['Pineapple', 0.5]]);
await recipe('Bottled Water', [['Bottled water 50cl', 1]]);

// An approved weekly count with explained variances.
const weekly = randomUUID();
await api.startStockCount({
  countId: weekly,
  branchId,
  note: 'Weekly count — meat, fish and drinks',
  itemIds: [ids['Chicken (whole legs)']!, ids.Tilapia!, ids.Beef!, ids['Coca-Cola 35cl']!, ids['Malt 33cl']!],
});
const counted: [string, number, string | null][] = [
  ['Chicken (whole legs)', 23.2, 'Trim loss not recorded'],
  ['Tilapia', 12, null],
  ['Beef', 4.5, null],
  ['Coca-Cola 35cl', 93, 'One bottle missing'],
  ['Malt 33cl', 40, null],
];
let current = await api.stockCount(weekly);
for (const [name, quantity, reason] of counted) {
  const line = current.items.find((i) => i.itemId === ids[name])!;
  const q = Math.abs(quantity - line.systemQuantity) < 0.0005 ? line.systemQuantity : quantity;
  await api.recordCountLine(weekly, {
    itemId: ids[name]!,
    countedQuantity: q,
    reason: q === line.systemQuantity ? null : reason,
  });
}
current = await api.stockCount(weekly);
await api.decideStockCount(weekly, 'submit', current.version);
current = await api.stockCount(weekly);
await api.decideStockCount(weekly, 'approve', current.version);

// A count in progress (dry store), partly counted.
const dry = randomUUID();
await api.startStockCount({
  countId: dry,
  branchId,
  note: 'Dry store — in progress',
  itemIds: [
    ids['Jasmine rice']!,
    ids['Parboiled rice']!,
    ids['Vegetable oil']!,
    ids.Flour!,
    ids['Beans (waakye)']!,
  ],
});
await api.recordCountLine(dry, {
  itemId: ids['Jasmine rice']!,
  countedQuantity: 58,
  reason: 'Spillage when refilling bins',
});
await api.recordCountLine(dry, { itemId: ids['Vegetable oil']!, countedQuantity: 25, reason: null });

const inv = await api.inventory(branchId);
console.log(
  JSON.stringify({
    seeded: true,
    items: inv.totals.items,
    lowStock: inv.totals.lowStock,
    value: inv.totals.value,
  }),
);
