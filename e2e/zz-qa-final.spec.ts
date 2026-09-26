import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { type Browser, type Page, test } from '@playwright/test';

// Manual-QA helper (not part of CI): the full 19-screen browser review with realistic data.
const OUT = process.env.QA_OUT!;
const env = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE!, 'utf8')) as {
  branchId: string;
  accounts: Record<string, { email: string; password: string }>;
};
const API = process.env.E2E_BASE_URL!;
async function token(account: string) {
  const auth = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY!, 'content-type': 'application/json' },
    body: JSON.stringify(env.accounts[account]),
  });
  return ((await auth.json()) as { access_token: string }).access_token;
}
async function call<T>(path: string, method = 'GET', body?: unknown, account = 'owner'): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${await token(account)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  if (!res.ok) console.log('API', method, path, res.status, JSON.stringify(json).slice(0, 200));
  return json;
}
const page = async (browser: Browser, width = 1366, height = 900) =>
  (await browser.newContext({ viewport: { width, height } })).newPage();
async function signIn(browser: Browser, account: string, width = 1366, height = 900) {
  const p = await page(browser, width, height);
  await p.goto('/login');
  await p.getByLabel('Email').fill(env.accounts[account]!.email);
  await p.getByLabel('Password').fill(env.accounts[account]!.password);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.waitForURL((u) => !u.pathname.startsWith('/login'));
  return p;
}
async function paired(browser: Browser, name: string, width = 1366, height = 900) {
  const config = await call<{ devices: { id: string; name: string }[] }>('/v1/admin/configuration');
  const device = config.devices.find((d) => d.name === name)!;
  const { code } = await call<{ code: string }>(`/v1/admin/devices/${device.id}/pairing-code`, 'POST', {});
  const p = await page(browser, width, height);
  await p.goto('/pair');
  await p.getByRole('button', { name: 'I have a code from a manager' }).click();
  await p.getByLabel('Pairing code').fill(code);
  await p.getByRole('button', { name: 'Pair device' }).click();
  await p.waitForTimeout(4000);
  return p;
}
const snap = async (p: Page, name: string, full = true) => {
  await p.waitForTimeout(1800);
  await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
};
test.skip(!process.env.QA_OUT, 'manual QA only');
test('final review', async ({ browser }) => {
  test.setTimeout(900_000);
  // --- data: photo on two dishes, a lunch promotion, a recipe with a low ingredient, a paid order
  const menu = await call<{
    products: { id: string; name: string }[];
    areas: { id: string; channel: string }[];
  }>(`/v1/branches/${env.branchId}/menu`);
  const id = (n: string) => menu.products.find((x) => x.name === n)!.id;
  const logo = readFileSync('apps/web/public/logo-512.png');
  for (const n of ['Jollof Rice', 'Grilled Chicken'])
    await fetch(`${API}/v1/products/${id(n)}/image`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token('owner')}`, 'content-type': 'image/png' },
      body: logo,
    });
  await call('/v1/promotions', 'POST', {
    name: 'Lunch Promotion',
    kind: 'fixed_price',
    amount: 5000,
    productIds: [id('Grilled Chicken')],
    categoryIds: [],
    appliesToAll: false,
    priority: 0,
    status: 'active',
  });
  const item = await call<{ id: string }>('/v1/inventory/items', 'POST', {
    branchId: env.branchId,
    name: `Rice QA ${randomUUID().slice(0, 4)}`,
    unit: 'kg',
    minQuantity: 5,
    unitCost: 1200,
    isActive: true,
  });
  await call('/v1/inventory/movements', 'POST', {
    movementId: randomUUID(),
    itemId: item.id,
    kind: 'receive',
    quantity: 4,
    reference: 'INV-204',
  });
  await call(`/v1/products/${id('Jollof Rice')}/recipe`, 'POST', {
    components: [{ itemId: item.id, quantity: 0.25 }],
  });
  const takeaway = menu.areas.find((a) => a.channel === 'takeaway')!.id;
  const order = await call<{ id: string; orderNumber: number }>(
    '/v1/orders/submit',
    'POST',
    {
      orderId: randomUUID(),
      branchId: env.branchId,
      areaId: takeaway,
      customerName: 'Abena',
      items: [
        { id: randomUUID(), productId: id('Grilled Chicken'), quantity: 1, modifierIds: [] },
        { id: randomUUID(), productId: id('Jollof Rice'), quantity: 2, modifierIds: [] },
        { id: randomUUID(), productId: id('Coke'), quantity: 2, modifierIds: [] },
      ],
      send: { submissionId: randomUUID() },
    },
    'cashier',
  );
  await call(
    `/v1/orders/${order.id}/payments`,
    'POST',
    { paymentId: randomUUID(), method: 'cash', tendered: 20000 },
    'cashier',
  );
  writeFileSync(`${OUT}/order.json`, JSON.stringify(order));

  // 1-2 login, PIN
  const anon = await page(browser);
  await anon.goto('/login');
  await snap(anon, '01-login');
  const till = await paired(browser, 'POS-01', 1280, 800);
  await snap(till, '02-pin');

  const owner = await signIn(browser, 'owner');
  // 3 dashboard
  await owner.goto('/dashboard');
  await snap(owner, '03-dashboard');
  // 4-6 menu, product editor, photo
  await owner.goto('/menu');
  await snap(owner, '04-menu');
  await owner
    .getByRole('row', { name: /Jollof Rice/ })
    .getByRole('button', { name: 'Edit' })
    .click();
  await owner.waitForTimeout(2500);
  await snap(owner, '05-product-editor', false);
  await owner.locator('.drawer .modal-body').evaluate((el) => el.scrollTo(0, 700));
  await snap(owner, '06-product-editor-photo-recipe', false);
  await owner.keyboard.press('Escape');
  // 8 promotion
  await owner.goto('/promotions');
  await snap(owner, '08-promotions');
  // 15-19 inventory, stock taking, staff, reports, settings, activity
  for (const [n, path] of [
    ['15-inventory', '/inventory'],
    ['16-stock-taking', '/stock-takes'],
    ['17-staff', '/staff'],
    ['18-reports', '/reports'],
    ['19-settings', '/settings'],
    ['20-activity', '/activity'],
  ] as const) {
    await owner.goto(path);
    await snap(owner, n);
  }
  // 7, 9 POS with photos, order
  const pos = await signIn(browser, 'owner', 1280, 800);
  await pos.goto('/pos');
  await pos.getByRole('tab', { name: 'Takeaway' }).click();
  await pos.getByRole('button', { name: /New takeaway order/ }).click();
  await pos.waitForTimeout(2000);
  await pos
    .getByRole('button', { name: /^Grilled Chicken/ })
    .first()
    .click();
  await pos
    .getByRole('button', { name: /^Jollof Rice/ })
    .first()
    .click();
  await snap(pos, '07-pos-photos', false);
  await pos
    .getByRole('button', { name: 'Back', exact: true })
    .click({ timeout: 5000 })
    .catch(() => undefined);
  await pos.goto('/pos');
  await pos.getByRole('tab', { name: 'Completed' }).click();
  await snap(pos, '09-order-list', false);
  // 10 kitchen (prices), 11 supervisor, 12 customer display
  const kds = await paired(browser, 'GRILL-01');
  await snap(kds, '10-kitchen');
  const sup = await signIn(browser, 'owner');
  await sup.goto('/expo');
  await snap(sup, '11-supervisor');
  const display = await paired(browser, 'CUSTOMER-DISPLAY-01', 1920, 1080);
  await snap(display, '12-customer-display', false);
  // 13-14 payment and receipt
  const receipt = await call<unknown>(`/v1/orders/${order.id}/receipt`);
  writeFileSync(`${OUT}/receipt.json`, JSON.stringify(receipt));
  // tablet + phone
  const tablet = await signIn(browser, 'owner', 1024, 768);
  await tablet.goto('/pos');
  await tablet
    .getByRole('button', { name: /^1 Available/ })
    .click({ timeout: 5000 })
    .catch(() => undefined);
  await snap(tablet, '21-pos-tablet', false);
  const phone = await signIn(browser, 'owner', 390, 844);
  await phone.goto('/activity');
  await snap(phone, '22-activity-phone');
});
