import { readFileSync } from 'node:fs';
import { type Browser, expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';

/**
 * Milestone scenarios A and B through the real UI: POS (staff login), four
 * station KDS screens and a customer display (paired with one-time codes),
 * real API, real Supabase Auth + Realtime + Postgres (DEV).
 */
const dev = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.dev-accounts.json', 'utf8')) as {
  branchId: string;
  accounts: Record<string, { email: string; password: string }>;
};
// Owner-side setup calls go to the same API the browser uses (same origin when deployed).
const API = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const ANON = process.env.SUPABASE_ANON_KEY!;

async function ownerToken(): Promise<string> {
  const { email, password } = dev.accounts.owner!;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

async function ownerApi<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${await ownerToken()}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function signedInPage(browser: Browser, account: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(dev.accounts[account]!.email);
  await page.getByLabel('Password').fill(dev.accounts[account]!.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  return page;
}

/** Pairs a fresh browser as the named device, exactly as staff would on the tablet. */
async function pairedPage(browser: Browser, deviceName: string): Promise<Page> {
  const config = await ownerApi<{ devices: { id: string; name: string }[] }>('/v1/admin/configuration');
  const device = config.devices.find((d) => d.name === deviceName)!;
  const { code } = await ownerApi<{ code: string }>(
    `/v1/admin/devices/${device.id}/pairing-code`,
    'POST',
    {},
  );
  const page = await (await browser.newContext()).newPage();
  await page.goto('/pair');
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair device' }).click();
  return page;
}

/** A paired till (POS-01) with a staff member signed in on it: receipts go to the till's printer. */
async function tillPage(browser: Browser, account: string): Promise<Page> {
  const page = await pairedPage(browser, 'POS-01');
  // A paired till opens on the staff PIN pad; these accounts sign in with email instead.
  await page.getByRole('button', { name: 'Manager sign-in (email)' }).click();
  await expect(page.getByText('This till: POS-01')).toBeVisible();
  await page.getByLabel('Email').fill(dev.accounts[account]!.email);
  await page.getByLabel('Password').fill(dev.accounts[account]!.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  return page;
}

async function addProduct(pos: Page, name: string, times: number) {
  for (let i = 0; i < times; i++) await pos.getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

test.describe
  .serial('Milestone scenarios in the browser', () => {
    let kds: Record<string, Page>;
    let display: Page;

    test.beforeAll(async ({ browser }) => {
      kds = {
        kitchen: await pairedPage(browser, 'KITCHEN-01'),
        grill: await pairedPage(browser, 'GRILL-01'),
        pastry: await pairedPage(browser, 'PASTRY-01'),
        drinks: await pairedPage(browser, 'DRINKS-01'),
      };
      display = await pairedPage(browser, 'CUSTOMER-DISPLAY-01');
      for (const page of Object.values(kds)) await expect(page.locator('.kds .bar')).toBeVisible();
      await expect(display.getByRole('region', { name: 'Ready' })).toBeVisible();
    });

    test('Scenario A — Table 12, four stations, split payment, served, completed', async ({ browser }) => {
      const pos = await signedInPage(browser, 'waiter');
      await pos.getByRole('tab', { name: 'Hall' }).click();
      await pos.locator('.table-card', { hasText: /^12/ }).click();
      await addProduct(pos, 'Jollof Rice', 2);
      await addProduct(pos, 'Grilled Chicken', 2);
      await addProduct(pos, 'Meat Pie', 2);
      await addProduct(pos, 'Coke', 2);
      await pos.getByRole('button', { name: 'Send to kitchen' }).click();

      const header = pos.locator('.cart strong').first();
      await expect(header).toContainText(/Order #\d+ · Table 12/);
      const orderNumber = (await header.innerText()).match(/#(\d+)/)![1]!;
      await expect(pos.locator('.line')).toHaveCount(4);

      // Each station sees only its own items.
      const ticket = (page: Page) => page.getByRole('article', { name: `Order ${orderNumber}` });
      await expect(ticket(kds.kitchen!)).toContainText('2 × JOLLOF');
      await expect(ticket(kds.kitchen!)).not.toContainText('Grilled Chicken');
      await expect(ticket(kds.grill!)).toContainText('2 × Grilled Chicken');
      await expect(ticket(kds.pastry!)).toContainText('2 × Meat Pie');
      await expect(ticket(kds.drinks!)).toContainText('2 × Coke');
      await expect(ticket(kds.grill!)).toContainText('Table 12');

      await expect(display.getByRole('region', { name: 'Preparing' })).toContainText(orderNumber);
      await ticket(kds.kitchen!).getByRole('button', { name: 'START' }).click();
      for (const station of ['kitchen', 'grill', 'pastry', 'drinks'] as const) {
        await ticket(kds[station]!).getByRole('button', { name: 'READY' }).click();
      }
      await expect(display.getByRole('region', { name: 'Ready' })).toContainText(orderNumber);
      await expect(pos.locator('.cart .badge').first()).toHaveText('Ready');

      await pos.getByRole('button', { name: 'Served' }).click();
      await expect(pos.locator('.cart .badge').first()).toHaveText('Served');
      await pos.close();

      // Cashier takes a split payment: cash 150.00, then MoMo for the rest.
      const cashier = await tillPage(browser, 'cashier');
      await cashier.getByRole('tab', { name: 'Hall' }).click();
      await cashier.locator('.table-card', { hasText: /^12/ }).click();
      await cashier.getByRole('button', { name: 'Take payment' }).click();
      await cashier.getByRole('button', { name: 'SPLIT' }).click();
      await cashier.getByRole('button', { name: 'CASH' }).click();
      await cashier.getByLabel(/Amount for this payment/).fill('150');
      await cashier.getByLabel('Cash received').fill('200');
      await expect(cashier.locator('.modal .totals').last()).toContainText('GHS 50.00');
      await cashier.getByRole('button', { name: 'Record this payment' }).click();
      await expect(cashier.locator('.modal')).toContainText('GHS 110.00');
      await cashier.getByRole('button', { name: 'MOMO' }).click();
      await cashier.getByLabel(/Amount for this payment/).fill('110');
      await cashier.getByLabel(/MoMo transaction ID/).fill('MTN-E2E-1');
      await cashier.getByRole('button', { name: 'Record this payment' }).click();
      await expect(cashier.locator('.cart .badge').first()).toHaveText('Completed');
      await expect(cashier.locator('.cart .badge').nth(1)).toHaveText('Paid');
      await cashier.getByRole('button', { name: 'Print receipt' }).click();
      // The receipt is queued on POS-01's receipt printer (the till is paired); no error shown.
      await expect
        .poll(async () =>
          (
            await ownerApi<{ jobs: { kind: string; orderNumber: number | null; printerName: string }[] }>(
              `/v1/branches/${dev.branchId}/print-queue`,
            )
          ).jobs.some(
            (j) =>
              j.kind === 'receipt' &&
              String(j.orderNumber) === orderNumber &&
              j.printerName === 'RECEIPT-PRINTER-01',
          ),
        )
        .toBe(true);
      await expect(cashier.locator('.cart .error')).toHaveCount(0);

      // Later, from Completed orders: open the closed order and reprint. Queued again as REPRINT,
      // audited, and the sale is unchanged (not reopened, no payment added).
      await cashier.getByRole('button', { name: 'Done' }).click();
      await cashier.getByRole('tab', { name: 'Completed', exact: true }).click();
      await cashier
        .getByRole('row', { name: new RegExp(`^${orderNumber}\\b`) })
        .getByRole('button', { name: 'Open' })
        .click();
      await expect(cashier.locator('.cart .badge').first()).toHaveText('Completed');
      await cashier.getByRole('button', { name: 'Reprint receipt' }).click();
      await expect(cashier.getByText('Receipt sent to the printer (marked REPRINT)')).toBeVisible();
      await expect
        .poll(async () => {
          const q = await ownerApi<{ jobs: { kind: string; orderNumber: number | null }[] }>(
            `/v1/branches/${dev.branchId}/print-queue`,
          );
          return q.jobs.filter((j) => j.kind === 'receipt' && String(j.orderNumber) === orderNumber).length;
        })
        .toBe(2);
      const db = postgres(process.env.TEST_DATABASE_URL!, { prepare: false, max: 1, onnotice: () => {} });
      const [audit] =
        await db`select count(*)::int as n from audit_logs a join orders o on o.id::text = a.entity_id
        where a.action = 'receipt.reprint' and o.order_number = ${Number(orderNumber)} and o.branch_id = ${dev.branchId}`;
      const [pay] = await db`select count(*)::int as n from payments p join orders o on o.id = p.order_id
        where o.order_number = ${Number(orderNumber)} and o.branch_id = ${dev.branchId}`;
      await db.end();
      expect(audit!.n).toBe(1);
      expect(pay!.n).toBe(2); // the cash + MoMo split: reprint added no payment
      await cashier.getByRole('button', { name: 'View receipt' }).click();
      await expect(cashier.locator('.receipt-paper')).toContainText('CASH');
      await expect(cashier.locator('.receipt-paper')).toContainText('MOBILE MONEY');
    });

    test('Scenario B — Takeaway: cake to two pastry printers, card, ready for pickup, picked up', async ({
      browser,
    }) => {
      const pos = await signedInPage(browser, 'cashier');
      await pos.getByRole('tab', { name: 'Takeaway' }).click();
      await pos.getByRole('button', { name: '+ New takeaway order' }).click();
      await pos.getByLabel('Customer name').fill('Kwame Mensah');
      await addProduct(pos, 'Birthday Cake', 1);
      await addProduct(pos, 'Meat Pie', 2);
      await addProduct(pos, 'Chicken Sandwich', 1);
      await addProduct(pos, 'Coke', 2);
      await pos.getByRole('button', { name: 'Send to kitchen' }).click();
      const header = pos.locator('.cart strong').first();
      await expect(header).toContainText(/Takeaway #\d+/);
      const orderNumber = (await header.innerText()).match(/#(\d+)/)![1]!;

      const ticket = (page: Page) => page.getByRole('article', { name: `Order ${orderNumber}` });
      await expect(ticket(kds.pastry!)).toContainText('1 × Birthday Cake');
      await expect(ticket(kds.pastry!)).toContainText('2 × Meat Pie');
      await expect(ticket(kds.kitchen!)).toContainText('1 × Chicken Sandwich');
      await expect(ticket(kds.drinks!)).toContainText('2 × Coke');
      await expect(ticket(kds.grill!)).toHaveCount(0);
      await expect(ticket(kds.pastry!)).toContainText('Kwame Mensah');

      // Card payment first (takeaway area is configured pay-before-handover).
      await pos.getByRole('button', { name: 'Take payment' }).click();
      await pos.getByRole('button', { name: 'CARD' }).click();
      await pos.getByRole('button', { name: 'Complete payment' }).click();
      await expect(pos.locator('.cart .badge').nth(1)).toHaveText('Paid');

      for (const station of ['pastry', 'kitchen', 'drinks'] as const) {
        await ticket(kds[station]!).getByRole('button', { name: 'READY' }).click();
      }
      await expect(display.getByRole('region', { name: 'Ready' })).toContainText(orderNumber);
      await pos.getByRole('button', { name: 'Picked up' }).click();
      await expect(pos.locator('.cart .badge').first()).toHaveText('Completed');
      await expect(display.getByRole('region', { name: 'Ready' })).not.toContainText(orderNumber);

      // The cake ticket was queued for both pastry printers (product override). No agent runs in this test, so jobs wait in the queue.
      const config = await ownerApi<{ devices: { id: string; name: string }[] }>('/v1/admin/configuration');
      const queue = await ownerApi<{
        jobs: { printerId: string; orderNumber: number | null; kind: string }[];
      }>(`/v1/branches/${dev.branchId}/print-queue`);
      const printerNames = queue.jobs
        .filter((j) => String(j.orderNumber) === orderNumber && j.kind === 'kitchen_ticket')
        .map((j) => config.devices.find((d) => d.id === j.printerId)?.name)
        .sort();
      expect(printerNames).toEqual([
        'DRINKS-PRINTER-01',
        'KITCHEN-PRINTER-01',
        'PASTRY-PRINTER-01',
        'PASTRY-PRINTER-02',
      ]);
    });
  });

test.describe
  .serial('Admin and operations views in the browser', () => {
    test('owner sees devices with live status, print queue, menu, routing, areas with payment policy, staff; reprint is audited', async ({
      browser,
    }) => {
      const owner = await signedInPage(browser, 'owner');
      // Owners land on the dashboard; everything else is one click away in the sidebar.
      await expect(owner.getByRole('heading', { name: /^Welcome back/ })).toBeVisible();
      await expect(owner.getByText('Sales today')).toBeVisible();
      await owner.getByRole('link', { name: 'Devices & printing' }).click();
      // Devices: every configured device listed with a status from heartbeats
      const devices = owner.locator('section', { hasText: 'Device status' });
      for (const name of [
        'POS-01',
        'KITCHEN-01',
        'PASTRY-01',
        'CUSTOMER-DISPLAY-01',
        'PRINT-AGENT-01',
        'KITCHEN-PRINTER-01',
      ]) {
        await expect(devices.getByRole('cell', { name, exact: true })).toBeVisible();
      }
      // Paired screens from the scenarios have reported heartbeats
      await expect(
        devices
          .getByRole('row', { name: /KITCHEN-01/ })
          .locator('.badge')
          .first(),
      ).toHaveText(/Online|Offline|Not connected/);
      await owner.getByRole('link', { name: 'Menu' }).click();
      await expect(owner.getByRole('row', { name: /Birthday Cake/ })).toContainText('→ Pastry');
      await owner.getByRole('link', { name: 'Stations & routing' }).click();
      await expect(owner.getByRole('heading', { name: 'Where each item goes' })).toBeVisible();
      await expect(owner.getByText('PASTRY-PRINTER-01 · primary')).toBeVisible();
      await owner.getByRole('link', { name: 'Floor & tables' }).click();
      await expect(owner.getByRole('row', { name: /Takeaway/ }).locator('select')).toHaveValue(
        'pay_before_fulfillment',
      );
      await expect(owner.getByRole('row', { name: /Hall/ }).locator('select')).toHaveValue(
        'pay_after_fulfillment',
      );
      await owner.getByRole('link', { name: 'Staff', exact: true }).click();
      await expect(owner.getByRole('cell', { name: /Cashier/ }).first()).toBeVisible();
      await owner.getByRole('tab', { name: /Roles & permissions/ }).click();
      await expect(owner.getByRole('cell', { name: 'Take orders' })).toBeVisible();
      await owner.getByRole('link', { name: 'Devices & printing' }).click();
      await expect(owner.getByText('Print jobs not yet printed')).toBeVisible();
    });
  });
