import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Browser, expect, type Page, test } from '@playwright/test';

/**
 * Failure behaviour in a real browser against the deployed environment.
 * For each case: what the user sees, whether data stays safe, and whether retry is safe.
 */
const dev = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.dev-accounts.json', 'utf8')) as {
  branchId: string;
  accounts: Record<string, { email: string; password: string }>;
};
const API = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787';

async function tokenFor(account: string): Promise<string> {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY!, 'content-type': 'application/json' },
    body: JSON.stringify(dev.accounts[account]),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}
async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  account = 'owner',
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${await tokenFor(account)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as T };
}
async function signIn(browser: Browser, account: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(dev.accounts[account]!.email);
  await page.getByLabel('Password').fill(dev.accounts[account]!.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  return page;
}
async function paired(browser: Browser, deviceName: string): Promise<{ page: Page; deviceId: string }> {
  const config = await api<{ devices: { id: string; name: string }[] }>('/v1/admin/configuration');
  const device = config.json.devices.find((d) => d.name === deviceName)!;
  const { json } = await api<{ code: string }>(`/v1/admin/devices/${device.id}/pairing-code`, 'POST', {});
  const page = await (await browser.newContext()).newPage();
  await page.goto('/pair');
  await page.getByLabel('Pairing code').fill(json.code);
  await page.getByRole('button', { name: 'Pair device' }).click();
  return { page, deviceId: device.id };
}
async function menuIds() {
  const { json } = await api<{
    products: { id: string; name: string }[];
    areas: { id: string; channel: string }[];
  }>(`/v1/branches/${dev.branchId}/menu`);
  return {
    product: (n: string) => json.products.find((p) => p.name === n)!.id,
    takeaway: json.areas.find((a) => a.channel === 'takeaway')!.id,
  };
}
const openTakeawayNumbers = async () =>
  (await api<{ orderNumber: number; channel: string }[]>(`/v1/branches/${dev.branchId}/orders`)).json
    .filter((o) => o.channel === 'takeaway')
    .map((o) => o.orderNumber);

test.describe
  .serial('Failure behaviour', () => {
    test('API unreachable during send: clear error, nothing created; retry creates exactly one order', async ({
      browser,
    }) => {
      const pos = await signIn(browser, 'cashier');
      await pos.getByRole('button', { name: 'Takeaway' }).click();
      await pos.getByRole('button', { name: '+ New takeaway order' }).click();
      await pos.getByRole('button', { name: /^Coke/ }).click();
      const before = await openTakeawayNumbers();
      await pos.route('**/v1/orders/submit', (route) => route.abort('internetdisconnected'));
      await pos.getByRole('button', { name: 'Send to kitchen' }).click();
      await expect(pos.getByRole('alert')).toContainText('No connection to the server');
      await expect(pos.getByRole('button', { name: 'Retry send' })).toBeVisible();
      expect(await openTakeawayNumbers()).toEqual(before);
      await pos.unroute('**/v1/orders/submit');
      await pos.getByRole('button', { name: 'Retry send' }).click();
      await expect(pos.locator('.cart strong').first()).toContainText(/Takeaway #\d+/);
      expect((await openTakeawayNumbers()).length).toBe(before.length + 1);
    });

    test('response lost after the server saved the order: retry does NOT duplicate it', async ({
      browser,
    }) => {
      const pos = await signIn(browser, 'cashier');
      await pos.getByRole('button', { name: 'Takeaway' }).click();
      await pos.getByRole('button', { name: '+ New takeaway order' }).click();
      await pos.getByRole('button', { name: /^Malt/ }).click();
      const before = await openTakeawayNumbers();
      let dropped = false;
      await pos.route('**/v1/orders/submit', async (route) => {
        if (dropped) return route.continue();
        dropped = true;
        await route.fetch(); // request reaches the server and commits...
        await route.abort('connectionreset'); // ...but the browser never sees the answer
      });
      await pos.getByRole('button', { name: 'Send to kitchen' }).click();
      await expect(pos.getByRole('alert')).toBeVisible();
      await expect.poll(async () => (await openTakeawayNumbers()).length).toBe(before.length + 1); // saved once
      await pos.getByRole('button', { name: 'Retry send' }).click();
      await expect(pos.locator('.cart strong').first()).toContainText(/Takeaway #\d+/);
      expect((await openTakeawayNumbers()).length).toBe(before.length + 1); // still one
    });

    test('browser refresh: an unsent cart is lost (known limitation); a sent order is fully recovered', async ({
      browser,
    }) => {
      const pos = await signIn(browser, 'waiter');
      await pos.getByRole('button', { name: 'Hall' }).click();
      await pos.locator('.table-card', { hasText: /^3/ }).click();
      await pos.getByRole('button', { name: /^Coke/ }).click();
      await pos.reload();
      await pos.getByRole('button', { name: 'Hall' }).click();
      await expect(pos.locator('.table-card', { hasText: /^3/ })).toContainText('Available'); // cart not persisted
      await pos.locator('.table-card', { hasText: /^3/ }).click();
      await pos.getByRole('button', { name: /^Coke/ }).click();
      await pos.getByRole('button', { name: 'Send to kitchen' }).click();
      await expect(pos.locator('.cart strong').first()).toContainText(/Order #\d+ · Table 3/);
      await pos.reload();
      await pos.getByRole('button', { name: 'Hall' }).click();
      await expect(pos.locator('.table-card', { hasText: /^3/ })).toContainText('Occupied');
      await pos.locator('.table-card', { hasText: /^3/ }).click();
      await expect(pos.locator('.line')).toContainText('1 × Coke');
    });

    test('KDS and customer display offline while an order is placed: both show it after reconnecting', async ({
      browser,
    }) => {
      const kds = await paired(browser, 'DRINKS-01');
      const display = await paired(browser, 'CUSTOMER-DISPLAY-01');
      // Both screens must be fully paired and showing live data before the network drops.
      await expect(kds.page.locator('.kds .bar')).toBeVisible();
      await expect(display.page.getByRole('region', { name: 'Ready' })).toBeVisible();
      await kds.page.context().setOffline(true);
      await display.page.context().setOffline(true);
      const ids = await menuIds();
      const { json: order } = await api<{ orderNumber: number }>(
        '/v1/orders/submit',
        'POST',
        {
          orderId: randomUUID(),
          branchId: dev.branchId,
          areaId: ids.takeaway,
          items: [{ id: randomUUID(), productId: ids.product('Coke'), quantity: 3, modifierIds: [] }],
          send: { submissionId: randomUUID() },
        },
        'cashier',
      );
      await kds.page.waitForTimeout(3000);
      await expect(kds.page.getByRole('article', { name: `Order ${order.orderNumber}` })).toHaveCount(0); // offline: not seen
      await kds.page.context().setOffline(false);
      await display.page.context().setOffline(false);
      // Reconnect -> authoritative reload (online event + realtime rejoin + safety poll)
      await expect(kds.page.getByRole('article', { name: `Order ${order.orderNumber}` })).toContainText(
        '3 × Coke',
        { timeout: 45_000 },
      );
      await expect(display.page.getByRole('region', { name: 'Preparing' })).toContainText(
        String(order.orderNumber),
        { timeout: 45_000 },
      );
    });

    test('device revoked while active: its next action is refused and it drops to sign-in', async ({
      browser,
    }) => {
      const kds = await paired(browser, 'GRILL-01');
      await expect(kds.page.locator('.kds .bar')).toBeVisible();
      const revoke = await api(`/v1/admin/devices/${kds.deviceId}/revoke`, 'POST', {});
      expect(revoke.status).toBe(200);
      await kds.page.reload();
      await expect(kds.page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    });

    test('staff deactivated while signed in: next action is refused', async ({ browser }) => {
      // A throwaway waiter, so the shared accounts stay usable.
      const config = await api<{ roles: { id: string; name: string }[] }>('/v1/admin/configuration');
      const email = `temp.${randomUUID().slice(0, 6)}@staff.example.com`;
      const password = `${randomUUID()}A1`;
      const created = await api<{ staffId: string }>('/v1/admin/staff', 'POST', {
        displayName: 'Temp Waiter',
        email,
        password,
        roleIds: [config.json.roles.find((r) => r.name === 'Waiter')!.id],
        branchId: dev.branchId,
      });
      dev.accounts.temp = { email, password };
      const pos = await signIn(browser, 'temp');
      await pos.getByRole('button', { name: 'Hall' }).click();
      await expect(pos.locator('.table-card').first()).toBeVisible();
      await api(`/v1/admin/staff/${created.json.staffId}`, 'POST', { isActive: false });
      await pos.reload();
      await expect(pos.getByRole('alert')).toContainText(/permission|no access/);
    });
  });
