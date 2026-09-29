import { readFileSync } from 'node:fs';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { usePasswordSignIn } from './support';

/**
 * Regression for the 2026-09-29 pairing incident: a till shows a code, the manager enters that
 * exact code, the till pairs and STAYS paired (no new code appears: not after waiting, not after a
 * refresh, not after reopening). A manager code typed in the wrong box says where it belongs.
 */
const env = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.dev-accounts.json', 'utf8')) as {
  accounts: Record<string, { email: string; password: string }>;
};

async function owner(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await usePasswordSignIn(page);
  await page.getByLabel('Email').fill(env.accounts.owner!.email);
  await page.getByLabel('Password').fill(env.accounts.owner!.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto('/devices');
  return page;
}

test('till: displayed code accepted at once; stays paired after waiting, refresh and reopen', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  const till = await context.newPage();
  await till.goto('/pair');
  const codeBox = till.locator('.pair-code');
  await expect(codeBox).toHaveText(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/, { timeout: 20_000 });
  const code = (await codeBox.textContent())!;

  const manager = await owner(browser);
  await manager
    .getByRole('row', { name: /POS-01/ })
    .getByRole('button', { name: 'Enter code from device' })
    .click();
  await manager.getByLabel('Code shown on the device').fill(code);
  await manager.getByRole('button', { name: 'Pair device', exact: true }).click();
  await expect(manager.getByRole('dialog')).toBeHidden({ timeout: 15_000 });

  // The till continues by itself to its PIN pad, and no new code appears.
  await expect(till.getByRole('heading', { name: 'Enter your staff PIN' })).toBeVisible({ timeout: 30_000 });
  await till.waitForTimeout(8000);
  await expect(till.locator('.pair-code')).toHaveCount(0);
  await expect(till.getByRole('heading', { name: 'Enter your staff PIN' })).toBeVisible();

  // Refresh: still paired.
  await till.reload();
  await expect(till.getByRole('heading', { name: 'Enter your staff PIN' })).toBeVisible();
  await expect(till.locator('.pair-code')).toHaveCount(0);

  // Reopen (a new window of the same browser): still paired.
  const reopened = await context.newPage();
  await reopened.goto('/');
  await expect(reopened.getByRole('heading', { name: 'Enter your staff PIN' })).toBeVisible();

  // Opening the pairing page on a paired till asks first; no code is created.
  await reopened.goto('/pair');
  await expect(reopened.getByRole('heading', { name: 'This device is already paired' })).toBeVisible();
  await reopened.waitForTimeout(4000);
  await expect(reopened.locator('.pair-code')).toHaveCount(0);

  // Entering the same code again (double submit) is harmless. (Fresh list: the till registers its
  // login a moment after approval.)
  await manager.reload();
  await manager
    .getByRole('row', { name: /POS-01/ })
    .getByRole('button', { name: 'Enter code from device' })
    .click();
  await expect(manager.getByRole('dialog')).toContainText('POS-01 is already paired');
  await manager.getByLabel('Code shown on the device').fill(code);
  await manager.getByRole('button', { name: 'Pair device', exact: true }).click();
  await expect(manager.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
  await till.reload();
  await expect(till.getByRole('heading', { name: 'Enter your staff PIN' })).toBeVisible();
});

test('a "Create code" code typed into "Enter code from device" explains where it belongs', async ({
  browser,
}) => {
  const manager = await owner(browser);
  await manager
    .getByRole('row', { name: /CUSTOMER-DISPLAY-01/ })
    .getByRole('button', { name: 'Create code' })
    .click();
  const made = (await manager.locator('.pair-code').textContent())!.trim();
  await manager.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await manager
    .getByRole('row', { name: /CUSTOMER-DISPLAY-01/ })
    .getByRole('button', { name: 'Enter code from device' })
    .click();
  await manager.getByLabel('Code shown on the device').fill(made);
  await manager.getByRole('button', { name: 'Pair device', exact: true }).click();
  await expect(manager.getByRole('alert')).toContainText('Type it on the device itself');
});
