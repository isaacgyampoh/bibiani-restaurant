import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Browser, expect, type Page, test } from '@playwright/test';

/**
 * Pricing in the browser: the owner creates a promotion with a live preview, the POS shows it,
 * the order line keeps the promotional price, the kitchen screen shows quantity × unit price and the
 * promotion, and a manager discount (with a reason) appears on the receipt. Cashiers cannot discount.
 */
const env = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.dev-accounts.json', 'utf8')) as {
  branchId: string;
  restaurant: { currency: string };
  accounts: Record<string, { email: string; password: string }>;
};
const API = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787';

async function call<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  account = 'owner',
): Promise<{ status: number; body: T }> {
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
  return { status: res.status, body: (await res.json()) as T };
}
async function signIn(browser: Browser, account: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(env.accounts[account]!.email);
  await page.getByLabel('Password').fill(env.accounts[account]!.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  return page;
}
async function paired(browser: Browser, deviceName: string) {
  const config = (await call<{ devices: { id: string; name: string }[] }>('/v1/admin/configuration')).body;
  const device = config.devices.find((d) => d.name === deviceName)!;
  const { code } = (await call<{ code: string }>(`/v1/admin/devices/${device.id}/pairing-code`, 'POST', {}))
    .body;
  const page = await (await browser.newContext()).newPage();
  await page.goto('/pair');
  await page.getByRole('button', { name: 'I have a code from a manager' }).click();
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair device' }).click();
  return page;
}

test('promotion: preview, POS badge, order snapshot, kitchen prices; manager discount on the receipt', async ({
  browser,
}) => {
  const cur = env.restaurant.currency;
  const owner = await signIn(browser, 'owner');
  await owner.goto('/promotions');
  await owner.getByRole('button', { name: 'New promotion' }).click();
  const drawer = owner.getByRole('dialog', { name: 'New promotion' });
  await drawer.getByLabel('Name').fill('Coke Friday');
  await drawer.getByRole('button', { name: 'Amount off' }).click();
  await drawer.getByLabel(`Amount off each (${cur})`).fill('2');
  await drawer.locator('label.chip', { hasText: /^Coke ·/ }).click();
  // Live preview: normal vs promotional price, before anything is saved.
  const preview = drawer.locator('table.list.compact');
  await expect(preview).toContainText('Coke');
  await expect(preview).toContainText(`${cur} 10.00`);
  await expect(preview).toContainText(`${cur} 8.00`);
  await drawer.getByRole('button', { name: 'Save and turn on' }).click();
  const row = owner.getByRole('row', { name: /Coke Friday/ });
  await expect(row).toContainText('Live now');

  // POS menu carries the live promotion (the POS shows it struck through; the server re-prices).
  const menu = (
    await call<{
      products: { id: string; name: string; promotion: { name: string; price: number } | null }[];
      areas: { id: string; channel: string }[];
    }>(`/v1/branches/${env.branchId}/menu`)
  ).body;
  const coke = menu.products.find((p) => p.name === 'Coke')!;
  expect(coke.promotion).toMatchObject({ name: 'Coke Friday', price: 800 });

  const kds = await paired(browser, 'DRINKS-01');
  await expect(kds.locator('.kds .bar')).toBeVisible();

  const order = (
    await call<{
      id: string;
      orderNumber: number;
      grandTotal: number;
      items: { lineTotal: number; grossTotal: number; promotion: { name: string } | null }[];
    }>(
      '/v1/orders/submit',
      'POST',
      {
        orderId: randomUUID(),
        branchId: env.branchId,
        areaId: menu.areas.find((a) => a.channel === 'takeaway')!.id,
        customerName: 'Promo test',
        items: [{ id: randomUUID(), productId: coke.id, quantity: 2, modifierIds: [] }],
        send: { submissionId: randomUUID() },
      },
      'cashier',
    )
  ).body;
  expect(order.items[0]).toMatchObject({
    grossTotal: 2000,
    lineTotal: 1600,
    promotion: { name: 'Coke Friday' },
  });

  // Kitchen screen: quantity × unit price = gross, promotion, net line, ticket total.
  const ticket = kds.getByRole('article', { name: `Order ${order.orderNumber}` });
  await expect(ticket).toContainText(`2 × ${cur} 10.00 = ${cur} 20.00`, { timeout: 30_000 });
  await expect(ticket).toContainText('Coke Friday');
  await expect(ticket.locator('.ticket-total')).toContainText(`${cur} 16.00`);

  // Manager discount: cashier refused; manager applies with a reason; receipt shows both lines.
  const discount = { discountId: randomUUID(), kind: 'amount', value: 100, reason: 'Regular customer' };
  expect((await call(`/v1/orders/${order.id}/discount`, 'POST', discount, 'cashier')).status).toBe(403);
  const discounted = await call<{ grandTotal: number }>(
    `/v1/orders/${order.id}/discount`,
    'POST',
    discount,
    'manager',
  );
  expect(discounted.body.grandTotal).toBe(1500);
  const receipt = (
    await call<{ document: { blocks: { left?: string }[] } }>(`/v1/orders/${order.id}/receipt`)
  ).body;
  const lefts = receipt.document.blocks.map((b) => b.left).filter(Boolean);
  expect(lefts).toEqual(
    expect.arrayContaining(['   Promo: Coke Friday', 'Promotions', 'Discount (Regular customer)']),
  );

  // End it: new orders pay the normal price; the order above keeps its price.
  const promo = (await call<{ id: string; name: string; version: number }[]>('/v1/promotions')).body.find(
    (p) => p.name === 'Coke Friday',
  )!;
  await owner.goto('/promotions');
  await owner
    .getByRole('row', { name: /Coke Friday/ })
    .getByRole('button', { name: 'End' })
    .click();
  await owner.getByRole('button', { name: 'End promotion' }).click();
  await owner.getByRole('tab', { name: /Ended/ }).click();
  await expect(owner.getByRole('row', { name: /Coke Friday/ })).toContainText('Ended');
  expect(promo.version).toBeGreaterThan(0);
  const after = (await call<{ grandTotal: number }>(`/v1/orders/${order.id}`)).body;
  expect(after.grandTotal).toBe(1500);
});
