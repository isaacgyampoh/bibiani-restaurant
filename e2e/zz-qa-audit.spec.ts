import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Browser, type Page, test } from '@playwright/test';

// Manual-QA helper (not part of CI): captures every screen, including device screens, for a visual audit.
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
const ctx = async (browser: Browser, width = 1366, height = 900) =>
  (await browser.newContext({ viewport: { width, height } })).newPage();
async function signIn(browser: Browser, account: string, width = 1366, height = 900) {
  const page = await ctx(browser, width, height);
  await page.goto('/login');
  await page.getByLabel('Email').fill(env.accounts[account]!.email);
  await page.getByLabel('Password').fill(env.accounts[account]!.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  return page;
}
async function paired(browser: Browser, name: string, width = 1366, height = 900) {
  const config = await call<{ devices: { id: string; name: string }[] }>('/v1/admin/configuration');
  const device = config.devices.find((d) => d.name === name)!;
  const { code } = await call<{ code: string }>(`/v1/admin/devices/${device.id}/pairing-code`, 'POST', {});
  const page = await ctx(browser, width, height);
  await page.goto('/pair');
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair device' }).click();
  await page.waitForTimeout(4000);
  return page;
}
const snap = async (page: Page, name: string, full = true) => {
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
};
test.skip(!process.env.QA_OUT, 'manual QA only');
test('audit', async ({ browser }) => {
  test.setTimeout(600_000);
  const login = await ctx(browser);
  await login.goto('/login');
  await snap(login, 'a01-login');
  await login.goto('/pair');
  await snap(login, 'a02-pair');

  const pos = await paired(browser, 'POS-01', 1280, 800);
  await snap(pos, 'a03-pos-device-locked');

  const menu = await call<{
    products: { id: string; name: string }[];
    areas: { id: string; channel: string }[];
  }>(`/v1/branches/${env.branchId}/menu`);
  const p = (n: string) => menu.products.find((x) => x.name === n)!.id;
  const order = await call<{ id: string }>(
    '/v1/orders/submit',
    'POST',
    {
      orderId: randomUUID(),
      branchId: env.branchId,
      areaId: menu.areas.find((a) => a.channel === 'takeaway')!.id,
      customerName: 'Abena',
      items: [
        { id: randomUUID(), productId: p('Grilled Chicken'), quantity: 1, modifierIds: [] },
        { id: randomUUID(), productId: p('Coke'), quantity: 2, modifierIds: [] },
      ],
      send: { submissionId: randomUUID() },
    },
    'cashier',
  );

  const owner = await signIn(browser, 'owner');
  for (const [n, path] of [
    ['a04-orders', '/orders'],
    ['a05-stock-takes', '/stock-takes'],
    ['a06-menu', '/menu'],
    ['a07-routing', '/routing'],
    ['a08-floor', '/floor'],
    ['a09-devices', '/devices'],
  ] as const) {
    await owner.goto(path);
    await snap(owner, n);
  }
  await owner.goto('/menu');
  await owner.getByRole('button', { name: '+ Product' }).click();
  await snap(owner, 'a10-new-product', false);
  await owner.keyboard.press('Escape');

  const expo = await signIn(browser, 'owner', 1366, 900);
  await expo.goto('/expo');
  await snap(expo, 'a11-supervisor');

  const display = await paired(browser, 'CUSTOMER-DISPLAY-01', 1920, 1080);
  await snap(display, 'a12-customer-display', false);

  const kdsEmpty = await paired(browser, 'PASTRY-01', 1280, 800).catch(() => null);
  if (kdsEmpty) await snap(kdsEmpty, 'a13-kds-pastry');

  // POS order: open the takeaway order, payment and receipt
  const till = await signIn(browser, 'owner', 1280, 800);
  await till.goto('/pos');
  await till.getByRole('tab', { name: 'Takeaway' }).click();
  await snap(till, 'a14-pos-takeaway');
  await till
    .getByText('Abena')
    .first()
    .click()
    .catch(() => undefined);
  await snap(till, 'a15-pos-order');
  await till
    .getByRole('button', { name: /^Pay/ })
    .first()
    .click({ timeout: 5000 })
    .catch(() => undefined);
  await snap(till, 'a16-payment', false);
  await till.keyboard.press('Escape');
  await till
    .getByRole('button', { name: /Receipt/i })
    .first()
    .click({ timeout: 5000 })
    .catch(() => undefined);
  await snap(till, 'a17-receipt', false);

  const tablet = await signIn(browser, 'owner', 1024, 768);
  await tablet.goto('/pos');
  await tablet
    .getByRole('button', { name: /^1 Available/ })
    .click({ timeout: 5000 })
    .catch(() => undefined);
  await snap(tablet, 'a18-pos-tablet', false);
  const phone = await signIn(browser, 'owner', 390, 844);
  await phone.goto('/menu');
  await snap(phone, 'a19-menu-phone');
  void order;
});
