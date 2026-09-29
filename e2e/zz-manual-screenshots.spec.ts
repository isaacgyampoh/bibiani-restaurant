import { readFileSync } from 'node:fs';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { usePasswordSignIn } from './support';

/**
 * Captures the screenshots used in docs/manual (the Installation & Operations Manual) from STAGING
 * test data. Not part of the normal test run:
 *   MANUAL_SHOTS=docs/manual/images E2E_BASE_URL=https://restaurant-management-staging.vercel.app \
 *     ACCOUNTS_FILE=.staging-accounts.json npx playwright test e2e/zz-manual-screenshots.spec.ts
 */
const OUT = process.env.MANUAL_SHOTS;
test.skip(!OUT, 'manual screenshots only');
const env = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.dev-accounts.json', 'utf8')) as {
  accounts: Record<string, { email: string; password: string }>;
};

async function signedIn(browser: Browser, account: string, width = 1366, height = 860): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  await page.goto('/login');
  await usePasswordSignIn(page);
  await page.getByLabel('Email').fill(env.accounts[account]!.email);
  await page.getByLabel('Password').fill(env.accounts[account]!.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  return page;
}
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png` });
const settle = async (page: Page) => {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(800);
};

test('manual screenshots', async ({ browser }) => {
  test.setTimeout(600_000);
  // Sign-in screen of a new browser.
  const fresh = await (await browser.newContext({ viewport: { width: 1366, height: 860 } })).newPage();
  await fresh.goto('/login');
  await settle(fresh);
  await shot(fresh, '01-sign-in');

  // A device showing its pairing code.
  const device = await (await browser.newContext({ viewport: { width: 1366, height: 860 } })).newPage();
  await device.goto('/pair');
  await expect(device.locator('.pair-code')).toHaveText(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/, { timeout: 20_000 });
  await shot(device, '02-pair-this-device');
  const code = (await device.locator('.pair-code').textContent())!;

  const owner = await signedIn(browser, 'owner');
  await owner.goto('/devices');
  await settle(owner);
  await shot(owner, '03-devices-and-printing');
  await owner
    .getByRole('row', { name: /POS-01/ })
    .getByRole('button', { name: 'Enter code from device' })
    .click();
  await owner.getByLabel('Code shown on the device').fill(code);
  await shot(owner, '04-enter-code-from-device');
  await owner.getByRole('button', { name: 'Pair device', exact: true }).click();
  await expect(device.getByRole('heading', { name: 'Enter your staff PIN' })).toBeVisible({
    timeout: 30_000,
  });
  await shot(device, '05-till-pin-pad');
  await owner.reload();
  await owner
    .getByRole('row', { name: /CUSTOMER-DISPLAY-01/ })
    .getByRole('button', { name: 'Create code' })
    .click();
  await expect(owner.locator('.pair-code')).toBeVisible();
  await shot(owner, '06-create-code');
  await owner.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  const printerRow = owner.locator('tr', { has: owner.getByText('Printer', { exact: true }) }).first();
  await printerRow.getByRole('button', { name: 'Edit' }).click();
  await shot(owner, '07-edit-printer');
  await owner.getByRole('button', { name: 'Cancel' }).click();

  for (const [name, path] of [
    ['08-dashboard', '/dashboard'],
    ['09-stations-and-routing', '/routing'],
    ['10-floor-and-tables', '/floor'],
    ['11-menu', '/menu'],
    ['12-staff', '/staff'],
    ['13-settings', '/settings'],
    ['14-inventory', '/inventory'],
    ['15-stock-taking', '/stock-takes'],
    ['16-promotions', '/promotions'],
    ['17-customers', '/customers'],
    ['18-reports', '/reports'],
    ['19-end-of-day-report', '/reports/end_of_day'],
    ['20-orders', '/orders'],
    ['21-cash-register', '/register'],
    ['22-activity', '/activity'],
    ['23-set-up-guide', '/setup'],
  ] as const) {
    await owner.goto(path);
    await settle(owner);
    await shot(owner, name);
  }
  await owner.goto('/staff');
  await owner.getByRole('tab', { name: /Roles/ }).click();
  await settle(owner);
  await shot(owner, '24-roles-and-permissions');

  // POS: a takeaway order, then the payment window.
  const pos = await signedIn(browser, 'cashier');
  await pos.goto('/pos');
  await settle(pos);
  await shot(pos, '25-pos-home');
  await pos.getByRole('tab', { name: 'Takeaway' }).click();
  await pos.getByRole('button', { name: '+ New takeaway order' }).click();
  await pos.getByRole('button', { name: /^Jollof/ }).click();
  await pos.getByRole('button', { name: /^Coke/ }).click();
  await pos.getByLabel('Customer name').fill('Ama');
  await shot(pos, '26-pos-order');
  await pos.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(pos.locator('.cart strong').first()).toContainText(/Takeaway #\d+/);
  await pos.getByRole('button', { name: 'Take payment' }).click();
  await pos.getByRole('button', { name: 'CASH' }).click();
  await pos.getByLabel('Cash received').fill('100');
  await shot(pos, '27-payment');
  await pos.keyboard.press('Escape');
  await pos.getByRole('tab', { name: 'Bills' }).click();
  await settle(pos);
  await shot(pos, '28-pos-bills');

  // Kitchen, supervisor and customer display (owner may open all three).
  await owner.goto('/kds');
  await settle(owner);
  const station = owner.getByRole('button', { name: /Main Kitchen|Kitchen/ }).first();
  if (await station.isVisible().catch(() => false)) await station.click();
  await settle(owner);
  await shot(owner, '29-kitchen-screen');
  await owner.goto('/expo');
  await settle(owner);
  await shot(owner, '30-supervisor');
  await owner.goto('/display');
  await settle(owner);
  await shot(owner, '31-customer-display');

  // Phone layout.
  const phone = await signedIn(browser, 'owner', 390, 844);
  await phone.goto('/dashboard');
  await settle(phone);
  await shot(phone, '32-phone-home');
  await phone.locator('.tabbar').getByRole('button', { name: 'More' }).click();
  await shot(phone, '33-phone-more');
});
