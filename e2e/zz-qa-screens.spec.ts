import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { type Browser, test } from '@playwright/test';

// Manual-QA helper (not part of CI): screenshots of every screen for visual review.
const OUT = process.env.QA_OUT!;
const env = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE!, 'utf8')) as {
  branchId: string;
  accounts: Record<string, { email: string; password: string }>;
};
const API = process.env.E2E_BASE_URL!;
async function call<T>(path: string, method = 'GET', body?: unknown, account = 'owner'): Promise<T> {
  const auth = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY!, 'content-type': 'application/json' },
    body: JSON.stringify(env.accounts[account]),
  });
  const { access_token } = (await auth.json()) as { access_token: string };
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}
async function signIn(browser: Browser, account: string, width = 1366) {
  const page = await (await browser.newContext({ viewport: { width, height: 900 } })).newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(env.accounts[account]!.email);
  await page.getByLabel('Password').fill(env.accounts[account]!.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  return page;
}
test.skip(!process.env.QA_OUT, 'manual QA only');
test('screens', async ({ browser }) => {
  test.setTimeout(300_000);
  const menu = await call<{
    products: { id: string; name: string; categoryId: string }[];
    areas: { id: string; channel: string }[];
  }>(`/v1/branches/${env.branchId}/menu`);
  const jollof = menu.products.find((p) => p.name === 'Jollof Rice')!;
  await call('/v1/promotions', 'POST', {
    name: 'Jollof Friday',
    kind: 'percent_off',
    percentBp: 1000,
    productIds: [jollof.id],
    categoryIds: [],
    appliesToAll: false,
    priority: 0,
    status: 'active',
  });
  const coke = menu.products.find((p) => p.name === 'Coke')!;
  await call('/v1/promotions', 'POST', {
    name: '3 Cokes for 25',
    kind: 'bundle_price',
    amount: 2500,
    bundleQuantity: 3,
    productIds: [coke.id],
    categoryIds: [],
    appliesToAll: false,
    priority: 0,
    status: 'active',
    daysOfWeek: [5, 6],
  });
  const order = await call<{ id: string; orderNumber: number }>(
    '/v1/orders/submit',
    'POST',
    {
      orderId: randomUUID(),
      branchId: env.branchId,
      areaId: menu.areas.find((a) => a.channel === 'takeaway')!.id,
      customerName: 'Ama',
      items: [
        { id: randomUUID(), productId: jollof.id, quantity: 2, modifierIds: [] },
        { id: randomUUID(), productId: coke.id, quantity: 3, modifierIds: [] },
      ],
      send: { submissionId: randomUUID() },
    },
    'cashier',
  );
  await call(
    `/v1/orders/${order.id}/discount`,
    'POST',
    { discountId: randomUUID(), kind: 'amount', value: 500, reason: 'Regular customer' },
    'manager',
  );

  const owner = await signIn(browser, 'owner');
  const shot = async (name: string, path: string, wait = 2500) => {
    await owner.goto(path);
    await owner.waitForTimeout(wait);
    await owner.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  };
  await shot('01-dashboard', '/dashboard');
  await shot('02-promotions', '/promotions');
  await owner.getByRole('button', { name: 'New promotion' }).click();
  const d = owner.getByRole('dialog', { name: 'New promotion' });
  await d.getByLabel('Name').fill('Lunch special');
  await d.getByRole('button', { name: 'Promotional price' }).click();
  await d.getByLabel(/Promotional price each/).fill('50');
  await d
    .locator('label.chip', { hasText: /^Grilled Chicken ·/ })
    .click()
    .catch(() => undefined);
  await d.getByLabel('Only at certain times of day').check();
  await owner.waitForTimeout(1500);
  await owner.screenshot({ path: `${OUT}/03-promotion-drawer.png`, fullPage: true });
  await shot('04-pos', '/pos', 3000);
  await owner
    .getByRole('button', { name: /^1 Available/ })
    .click({ timeout: 5000 })
    .catch(() => undefined);
  await owner.waitForTimeout(2000);
  await owner
    .getByRole('button', { name: /Jollof Rice/ })
    .first()
    .click({ timeout: 5000 })
    .catch(() => undefined);
  await owner
    .getByRole('button', { name: /^Coke/ })
    .first()
    .click({ timeout: 5000 })
    .catch(() => undefined);
  await owner
    .getByRole('button', { name: 'More' })
    .last()
    .click({ timeout: 5000 })
    .catch(() => undefined);
  await owner
    .getByRole('button', { name: 'More' })
    .last()
    .click({ timeout: 5000 })
    .catch(() => undefined);
  await owner.waitForTimeout(800);
  await owner.screenshot({ path: `${OUT}/04c-pos-order.png`, fullPage: true });
  await shot('05-orders', '/orders');
  await shot('06-inventory', '/inventory');
  await shot('07-settings', '/settings');
  await shot('08-settings-kitchen', '/settings#kitchen');
  await shot('09-staff', '/staff');
  await shot('10-reports', '/reports');
  await owner.goto(`/orders`);
  await call<unknown>(`/v1/orders/${order.id}/receipt`).then((r) =>
    writeFileSync(`${OUT}/receipt.json`, JSON.stringify(r, null, 1)),
  );
  const config = await call<{ devices: { id: string; name: string }[] }>('/v1/admin/configuration');
  for (const name of ['KITCHEN-01', 'DRINKS-01']) {
    const device = config.devices.find((d) => d.name === name);
    if (!device) continue;
    const { code } = await call<{ code: string }>(`/v1/admin/devices/${device.id}/pairing-code`, 'POST', {});
    const kds = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
    await kds.goto('/pair');
    await kds.getByRole('button', { name: 'I have a code from a manager' }).click();
    await kds.getByLabel('Pairing code').fill(code);
    await kds.getByRole('button', { name: 'Pair device' }).click();
    await kds.waitForTimeout(5000);
    await kds.screenshot({ path: `${OUT}/13-kds-${name}.png`, fullPage: true });
  }
  const mobile = await signIn(browser, 'owner', 390);
  await mobile.goto('/promotions');
  await mobile.waitForTimeout(2500);
  await mobile.screenshot({ path: `${OUT}/11-promotions-mobile.png`, fullPage: true });
  await mobile.goto('/dashboard');
  await mobile.waitForTimeout(2500);
  await mobile.screenshot({ path: `${OUT}/12-dashboard-mobile.png`, fullPage: true });
  writeFileSync(`${OUT}/order.json`, JSON.stringify({ id: order.id, n: order.orderNumber }));
});
