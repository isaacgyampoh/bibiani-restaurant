import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Browser, expect, test } from '@playwright/test';

/**
 * Realtime with real clients: a paired KDS and customer display, both "Live", receive a new order
 * within a few seconds (the safety poll is 20-30 s, so this can only pass through Realtime).
 */
const env = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.dev-accounts.json', 'utf8')) as {
  branchId: string;
  accounts: Record<string, { email: string; password: string }>;
};
const API = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787';

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
async function paired(browser: Browser, deviceName: string) {
  const config = await call<{ devices: { id: string; name: string }[] }>('/v1/admin/configuration');
  const device = config.devices.find((d) => d.name === deviceName)!;
  const { code } = await call<{ code: string }>(`/v1/admin/devices/${device.id}/pairing-code`, 'POST', {});
  const page = await (await browser.newContext()).newPage();
  await page.goto('/pair');
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair device' }).click();
  return page;
}

test('KDS and customer display receive a new order live, well before any safety poll', async ({
  browser,
}) => {
  const kds = await paired(browser, 'DRINKS-01');
  const display = await paired(browser, 'CUSTOMER-DISPLAY-01');
  await expect(kds.locator('.kds .bar')).toBeVisible();
  await expect(kds.getByText('Live', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(display.getByRole('region', { name: 'Ready' })).toBeVisible();
  await kds.waitForTimeout(1500); // let the display's channel join too

  const menu = await call<{
    products: { id: string; name: string }[];
    areas: { id: string; channel: string }[];
  }>(`/v1/branches/${env.branchId}/menu`);
  const started = Date.now();
  const order = await call<{ orderNumber: number }>(
    '/v1/orders/submit',
    'POST',
    {
      orderId: randomUUID(),
      branchId: env.branchId,
      areaId: menu.areas.find((a) => a.channel === 'takeaway')!.id,
      items: [
        {
          id: randomUUID(),
          productId: menu.products.find((p) => p.name === 'Coke')!.id,
          quantity: 2,
          modifierIds: [],
        },
      ],
      send: { submissionId: randomUUID() },
    },
    'cashier',
  );
  await expect(kds.getByRole('article', { name: `Order ${order.orderNumber}` })).toContainText('2 × Coke', {
    timeout: 5_000,
  });
  await expect(display.getByRole('region', { name: 'Preparing' })).toContainText(String(order.orderNumber), {
    timeout: 5_000,
  });
  console.log(`realtime: order visible on KDS and display ${Date.now() - started} ms after submit returned`);
});
