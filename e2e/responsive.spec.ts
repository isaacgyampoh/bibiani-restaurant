import { readFileSync } from 'node:fs';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { usePasswordSignIn } from './support';

/**
 * Phone and tablet layouts: every main screen at common phone and tablet sizes, with no
 * horizontal page scrolling, phone navigation present, and the key flows (POS order, register
 * close, customers, report export) usable at phone size. Screenshots go to $QA_OUT when set.
 */
const dev = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.dev-accounts.json', 'utf8')) as {
  accounts: Record<string, { email: string; password: string }>;
};
const OUT = process.env.QA_OUT;
const SIZES = [
  { w: 320, h: 568 },
  { w: 360, h: 800 },
  { w: 375, h: 812 },
  { w: 390, h: 844 },
  { w: 412, h: 915 },
  { w: 768, h: 1024 },
  { w: 1024, h: 1366 },
];
const OWNER_SCREENS = [
  '/dashboard',
  '/orders',
  '/register',
  '/customers',
  '/reports',
  '/reports/end_of_day',
  '/reports/tax',
  '/reports/items',
  '/reports/overview',
  '/inventory',
  '/stock-takes',
  '/menu',
  '/promotions',
  '/staff',
  '/devices',
  '/floor',
  '/settings',
  '/activity',
];

const states = new Map<string, string>();
async function session(browser: Browser, account: string): Promise<string> {
  const known = states.get(account);
  if (known) return known;
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await usePasswordSignIn(page);
  await page.getByLabel('Email').fill(dev.accounts[account]!.email);
  await page.getByLabel('Password').fill(dev.accounts[account]!.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !/\/login$/.test(u.pathname), { timeout: 60_000 });
  await page.waitForLoadState('networkidle');
  const file = `test-results/state-${account}.json`;
  await page.context().storageState({ path: file });
  await page.context().close();
  states.set(account, file);
  return file;
}

async function open(browser: Browser, account: string, size: { w: number; h: number }): Promise<Page> {
  const context = await browser.newContext({
    storageState: await session(browser, account),
    viewport: { width: size.w, height: size.h },
    isMobile: size.w < 768,
    hasTouch: size.w < 1024,
  });
  return context.newPage();
}

/** Horizontal overflow of the page itself (inner scrolling areas such as tables are fine). */
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await expect(page.locator('.skeleton'))
    .toHaveCount(0, { timeout: 20_000 })
    .catch(() => undefined);
}

test.describe('Responsive layouts', () => {
  test.setTimeout(600_000);

  test('sign-in screen fits every size', async ({ browser }) => {
    for (const size of SIZES) {
      const page = await (
        await browser.newContext({ viewport: { width: size.w, height: size.h } })
      ).newPage();
      await page.goto('/login');
      await expect(page.getByRole('heading').first()).toBeVisible();
      expect.soft(await overflow(page), `/login at ${size.w}px`).toBeLessThanOrEqual(1);
      if (OUT) await page.screenshot({ path: `${OUT}/login-${size.w}.png` });
      await page.context().close();
    }
  });

  for (const size of SIZES) {
    test(`back office screens at ${size.w}×${size.h}`, async ({ browser }) => {
      const page = await open(browser, 'owner', size);
      for (const path of OWNER_SCREENS) {
        await page.goto(path);
        await settle(page);
        expect
          .soft(await overflow(page), `${path} at ${size.w}px overflows horizontally`)
          .toBeLessThanOrEqual(1);
        if (size.w < 900) {
          await expect(page.locator('.tabbar'), `${path}: phone navigation`).toBeVisible();
          await expect(page.locator('.sidebar')).toBeHidden();
        } else {
          await expect(page.locator('.sidebar')).toBeVisible();
        }
        if (OUT) await page.screenshot({ path: `${OUT}/${size.w}${path.replace(/\//g, '_')}.png` });
      }
      await page.context().close();
    });
  }

  test('phone: More opens every permitted screen, and sign-out', async ({ browser }) => {
    const page = await open(browser, 'owner', { w: 375, h: 812 });
    await page.goto('/dashboard');
    await page.locator('.tabbar').getByRole('button', { name: 'More' }).click();
    const sheet = page.getByRole('dialog', { name: 'More' });
    await expect(sheet).toBeVisible();
    for (const label of ['Customers', 'Reports', 'Staff', 'Settings', 'Stock'])
      await expect(sheet.getByRole('link', { name: label, exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Sign out' })).toBeVisible();
    if (OUT) await page.screenshot({ path: `${OUT}/375_more-sheet.png` });
    await sheet.getByRole('link', { name: 'Customers', exact: true }).click();
    await expect(page).toHaveURL(/\/customers$/);
    await page.context().close();
  });

  for (const size of [SIZES[0]!, SIZES[3]!, SIZES[5]!]) {
    test(`POS order on ${size.w}px: products, view order, send`, async ({ browser }) => {
      const page = await open(browser, 'cashier', size);
      await page.goto('/pos');
      await settle(page);
      expect(await overflow(page)).toBeLessThanOrEqual(1);
      if (OUT) await page.screenshot({ path: `${OUT}/${size.w}_pos-home.png` });
      await page.getByRole('tab', { name: 'Takeaway' }).click();
      await page.getByRole('button', { name: '+ New takeaway order' }).click();
      await page.getByRole('button', { name: /^Coke/ }).click();
      await page.getByRole('button', { name: /^Coke/ }).click();
      expect(await overflow(page)).toBeLessThanOrEqual(1);
      if (size.w < 640) {
        const bar = page.locator('.pos-summary');
        await expect(bar).toBeVisible();
        await expect(bar).toContainText('2 items');
        if (OUT) await page.screenshot({ path: `${OUT}/${size.w}_pos-menu.png` });
        await bar.getByRole('button', { name: 'View order' }).click();
      }
      await page.getByLabel('Customer name').fill('Phone Test');
      await expect(page.getByRole('button', { name: 'Send to kitchen' })).toBeVisible();
      if (OUT) await page.screenshot({ path: `${OUT}/${size.w}_pos-cart.png`, fullPage: true });
      await page.getByRole('button', { name: 'Send to kitchen' }).click();
      await expect(page.locator('.cart strong').first()).toContainText(/Takeaway #\d+/);
      expect(await overflow(page)).toBeLessThanOrEqual(1);
      await page.context().close();
    });
  }

  test('phone: open and close the cash register, then download the closing report', async ({ browser }) => {
    const page = await open(browser, 'cashier', { w: 390, h: 844 });
    await page.goto('/register');
    await settle(page);
    // A register left open by an earlier run is closed first.
    if (await page.getByRole('button', { name: 'Close register' }).isVisible()) {
      await page.getByRole('button', { name: 'Close register' }).click();
      await page.getByLabel(/Actual cash counted/).fill('0');
      await page.getByRole('button', { name: 'Review' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Close register' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    }
    await page.getByLabel(/Opening cash/).fill('500');
    if (OUT) await page.screenshot({ path: `${OUT}/390_register-open.png` });
    await page.getByRole('button', { name: /Open register with/ }).click();
    await expect(page.getByText('Expected cash in drawer')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    if (OUT) await page.screenshot({ path: `${OUT}/390_register-live.png` });
    await page.getByRole('button', { name: 'Close register' }).click();
    await page.getByLabel(/Actual cash counted/).fill('450');
    await expect(page.getByRole('status').filter({ hasText: 'Short by' })).toBeVisible();
    if (OUT) await page.screenshot({ path: `${OUT}/390_register-count.png` });
    await page.getByRole('button', { name: 'Review' }).click();
    const confirm = page.getByRole('dialog').getByRole('button', { name: 'Close register' });
    await confirm.dblclick(); // a double tap closes once
    const report = page.getByRole('dialog', { name: 'Register closing report' });
    await expect(report).toBeVisible();
    await expect(report.getByText('Variance', { exact: true })).toBeVisible();
    if (OUT) await page.screenshot({ path: `${OUT}/390_register-report.png` });
    await report.getByRole('button', { name: 'Export' }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: /PDF/ }).click();
    expect((await download).suggestedFilename()).toMatch(/^myfood-cashier-register-closing-.*\.pdf$/);
    await page.context().close();
  });

  test('phone: add a customer (phone required, duplicate refused), search and call link', async ({
    browser,
  }) => {
    const page = await open(browser, 'owner', { w: 375, h: 812 });
    await page.goto('/customers');
    await settle(page);
    const number = `024${String(Date.now()).slice(-7)}`;
    const name = `Mobile Customer ${number.slice(-4)}`;
    await page.getByRole('button', { name: 'Add customer' }).click();
    await page.getByLabel('Full name').fill(name);
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    await page.getByLabel('Telephone number').fill(number);
    if (OUT) await page.screenshot({ path: `${OUT}/375_customer-form.png` });
    await page.getByRole('button', { name: 'Save' }).click();
    const detail = page.getByRole('dialog', { name });
    await expect(detail.getByRole('link', { name: /^Call / })).toHaveAttribute('href', /^tel:\+233/);
    if (OUT) await page.screenshot({ path: `${OUT}/375_customer-detail.png` });
    await detail.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Add customer' }).click();
    await page.getByLabel('Full name').fill('Duplicate');
    await page.getByLabel('Telephone number').fill(`+233 ${number.slice(1)}`);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toContainText('already exists');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByLabel('Search customers').fill(number);
    await expect(page.getByText(name)).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    if (OUT) await page.screenshot({ path: `${OUT}/375_customers.png` });
    await page.context().close();
  });

  test('phone: report filters in a sheet and export as Excel and CSV', async ({ browser }) => {
    const page = await open(browser, 'owner', { w: 360, h: 800 });
    await page.goto('/reports/items');
    await settle(page);
    await page.getByRole('button', { name: 'This month' }).click();
    await page.getByRole('button', { name: /^Filters/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Filters' });
    await sheet.getByLabel('Service type').selectOption('takeaway');
    if (OUT) await page.screenshot({ path: `${OUT}/360_report-filters.png` });
    await sheet.getByRole('button', { name: 'Show results' }).click();
    await expect(page.getByText('Service type: Takeaway').first()).toBeVisible();
    for (const [label, ext] of [
      ['Excel', 'xlsx'],
      ['CSV', 'csv'],
    ] as const) {
      await page.getByRole('button', { name: 'Export' }).click();
      if (OUT && ext === 'xlsx') await page.screenshot({ path: `${OUT}/360_export-sheet.png` });
      const download = page.waitForEvent('download');
      await page.getByRole('menuitem', { name: new RegExp(`^${label}`) }).click();
      expect((await download).suggestedFilename()).toMatch(new RegExp(`^myfood-item-sales-.*\\.${ext}$`));
    }
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await page.context().close();
  });
});
