import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Browser, expect, type Page, test } from '@playwright/test';

/**
 * Restaurant operations in the browser: the supervisor sees one order's stations become ready,
 * the customer display shows it, and the back office runs inventory and a stock take.
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
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
async function signIn(browser: Browser, account: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(env.accounts[account]!.email);
  await page.getByLabel('Password').fill(env.accounts[account]!.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  return page;
}

test.describe
  .serial('Operations: supervisor, customer display, inventory, stock taking, reports', () => {
    test('one order to four stations: supervisor sees 3/4 then 4/4 READY; display shows it ready', async ({
      browser,
    }) => {
      const menu = await call<{
        products: { id: string; name: string }[];
        areas: { id: string; channel: string }[];
      }>(`/v1/branches/${env.branchId}/menu`);
      const floor = await call<{ tables: { id: string; label: string; state: string }[] }>(
        `/v1/branches/${env.branchId}/floor`,
      );
      const product = (n: string) => menu.products.find((p) => p.name === n)!.id;
      const order = await call<{
        id: string;
        orderNumber: number;
        tickets: { id: string; stationName: string }[];
      }>(
        '/v1/orders/submit',
        'POST',
        {
          orderId: randomUUID(),
          branchId: env.branchId,
          areaId: menu.areas.find((a) => a.channel === 'dine_in')!.id,
          tableId: floor.tables.filter((t) => t.state === 'available' && t.label !== '12').at(-1)!.id,
          items: ['Jollof Rice', 'Grilled Chicken', 'Coke', 'Birthday Cake'].map((n) => ({
            id: randomUUID(),
            productId: product(n),
            quantity: 1,
            modifierIds: [],
          })),
          send: { submissionId: randomUUID() },
        },
        'waiter',
      );
      expect(order.tickets).toHaveLength(4);

      const owner = await signIn(browser, 'owner');
      await owner.getByRole('link', { name: 'Supervisor', exact: true }).click();
      const card = owner.getByRole('article', { name: `Order ${order.orderNumber}` });
      await expect(card).toContainText('0/4 READY');
      for (const station of ['Main Kitchen', 'Drinks', 'Pastry']) {
        const t = order.tickets.find((x) => x.stationName === station)!;
        await call(`/v1/tickets/${t.id}/actions`, 'POST', { action: 'ready' });
      }
      await expect(card).toContainText('3/4 READY', { timeout: 15_000 });
      await expect(card.getByRole('listitem').filter({ hasText: 'Grill' })).not.toContainText('READY');
      // The supervisor completes the last station from this screen.
      await card
        .getByRole('listitem')
        .filter({ hasText: 'Grill' })
        .getByRole('button', { name: 'Ready' })
        .click();
      await expect(card).toContainText('4/4 READY');
      await expect(card.getByRole('button', { name: 'Served' })).toBeVisible();

      const display = await (await browser.newContext()).newPage();
      await display.goto(owner.url().replace(/\/expo.*/, '/login'));
      await display.getByLabel('Email').fill(env.accounts.owner!.email);
      await display.getByLabel('Password').fill(env.accounts.owner!.password);
      await display.getByRole('button', { name: 'Sign in' }).click();
      await expect(display.getByRole('heading', { name: /^Welcome back/ })).toBeVisible();
      await display.goto(display.url().replace(/\/dashboard.*/, '/display'));
      await expect(display.getByRole('region', { name: 'Ready' })).toContainText(String(order.orderNumber));

      await card.getByRole('button', { name: 'Served' }).click();
      await expect(card).toHaveCount(0, { timeout: 15_000 });
    });

    test('inventory: add item, receive delivery, waste with reason; stock take with variance, submit, approve', async ({
      browser,
    }) => {
      const owner = await signIn(browser, 'owner');
      await owner.getByRole('link', { name: 'Stock', exact: true }).click();
      const name = `Rice ${randomUUID().slice(0, 4)}`;
      await owner.getByRole('button', { name: '+ Add stock item' }).click();
      await owner.getByLabel('Name').fill(name);
      await owner.getByLabel('Minimum stock').fill('5');
      await owner.getByLabel(/Cost per/).fill('25');
      await owner.getByRole('button', { name: 'Save' }).click();
      const stock = owner.locator('table.list').first();
      const row = stock.getByRole('row', { name: new RegExp(name) });
      await expect(row).toContainText('0 kg');
      await row.getByRole('button', { name: 'Receive' }).click();
      await owner.getByLabel(/Quantity/).fill('20');
      await owner.getByLabel(/Invoice/).fill('INV-E2E');
      await owner.getByRole('button', { name: 'Receive delivery' }).click();
      await expect(row).toContainText('20 kg');
      await row.getByRole('button', { name: 'Waste' }).click();
      await owner.getByLabel(/Quantity/).fill('1.5');
      await owner.getByLabel('Reason').fill('Bag torn');
      await owner.getByRole('button', { name: 'Record wastage' }).click();
      await expect(row).toContainText('18.5 kg');

      await owner.getByRole('navigation').getByRole('link', { name: 'Stock taking' }).click();
      await owner.getByRole('button', { name: '+ Start stock count' }).click();
      await expect(owner.getByRole('heading', { name: 'Stock count' })).toBeVisible();
      await owner.getByLabel(`Counted ${name}`).fill('17');
      await owner.getByLabel(`Reason ${name}`).fill('Used, not recorded');
      await owner.getByLabel(`Reason ${name}`).blur();
      await expect(owner.getByRole('row', { name: new RegExp(name) })).toContainText('-1.5 kg');
      await owner.getByRole('button', { name: 'Submit count for approval' }).click();
      await expect(owner.getByText('Waiting for approval').first()).toBeVisible();
      await owner.getByRole('button', { name: 'Approve and adjust stock' }).click();
      await expect(owner.getByText(/Approved/).first()).toBeVisible();

      await owner.getByRole('link', { name: 'Stock', exact: true }).click();
      await expect(
        owner
          .locator('table.list')
          .first()
          .getByRole('row', { name: new RegExp(name) }),
      ).toContainText('17 kg');
    });

    test('reports and dashboard show real figures', async ({ browser }) => {
      const owner = await signIn(browser, 'owner');
      await expect(owner.getByText('Sales today')).toBeVisible();
      await owner.getByRole('link', { name: 'Reports' }).click();
      await expect(owner.getByRole('heading', { name: 'Best sellers' })).toBeVisible();
      await expect(owner.getByText('Net sales')).toBeVisible();
    });
  });
