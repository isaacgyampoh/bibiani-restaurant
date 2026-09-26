import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// Manual-QA helper (not part of CI): product photo upload in the menu editor and on the POS.
const OUT = process.env.QA_OUT!;
const env = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE!, 'utf8')) as {
  accounts: Record<string, { email: string; password: string }>;
};
test.skip(!process.env.QA_OUT, 'manual QA only');
test('photos', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(env.accounts.owner!.email);
  await page.getByLabel('Password').fill(env.accounts.owner!.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto('/menu');
  await page
    .getByRole('row', { name: /Grilled Chicken/ })
    .getByRole('button', { name: 'Edit' })
    .click();
  await page.locator('input[type=file]').setInputFiles('apps/web/public/logo-512.png');
  await expect(page.getByText('Change photo')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.photo-frame img')).toHaveJSProperty('complete', true);
  await page.waitForFunction(
    () => (document.querySelector('.photo-frame img') as HTMLImageElement)?.naturalWidth > 0,
  );
  await page.screenshot({ path: `${OUT}/20-product-photo-dialog.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/21-menu-thumbnails.png`, fullPage: true });
  await page.goto('/pos');
  await page.getByRole('button', { name: /^2 Available/ }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/22-pos-photos.png` });
});
