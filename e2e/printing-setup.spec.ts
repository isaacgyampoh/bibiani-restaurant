import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { usePasswordSignIn } from './support';

/** Devices & printing explains whether printing works; a printer can be edited; router addresses are flagged. */
const dev = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.dev-accounts.json', 'utf8')) as {
  accounts: Record<string, { email: string; password: string }>;
};

test('printing status, edit printer with a router warning, test print reports what happened', async ({
  browser,
}) => {
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  await page.goto('/login');
  await usePasswordSignIn(page);
  await page.getByLabel('Email').fill(dev.accounts.owner!.email);
  await page.getByLabel('Password').fill(dev.accounts.owner!.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !/\/login$/.test(u.pathname));
  await page.goto('/devices');
  const health = page.locator('.printing-health');
  await expect(health).toBeVisible();
  await expect(health).toContainText(
    /Printing (is on|is not running yet|has stopped|is running)|No printers yet/,
  );

  const row = page.locator('tr', { has: page.getByText('Printer', { exact: true }) }).first();
  await row.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog');
  if (process.env.QA_OUT) await page.screenshot({ path: `${process.env.QA_OUT}/edit-printer.png` });
  await expect(dialog.getByLabel('How is it connected?')).toBeVisible();
  const address = dialog.getByLabel('Printer IP address');
  const original = await address.inputValue();
  await address.fill('192.168.0.1');
  await expect(dialog).toContainText('usually the Wi-Fi router');
  await address.fill(original);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await row.getByRole('button', { name: 'Test print' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /Test page sent|printed|did not print|has not printed yet/ })
      .first(),
  ).toBeVisible();
});
