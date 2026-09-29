import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { usePasswordSignIn } from './support';

/**
 * Dual-screen till: the POS window and the customer-facing window run in the same browser on the
 * same machine. The customer sees the order as it is rung up, then "Thank you" with the change.
 */
const dev = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.dev-accounts.json', 'utf8')) as {
  accounts: Record<string, { email: string; password: string }>;
};

test('customer screen follows the till: items, total, then paid with change', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pos = await context.newPage();
  await pos.goto('/login');
  await usePasswordSignIn(pos);
  await pos.getByLabel('Email').fill(dev.accounts.cashier!.email);
  await pos.getByLabel('Password').fill(dev.accounts.cashier!.password);
  await pos.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(pos.getByRole('tab', { name: 'Takeaway' })).toBeVisible();

  // The second monitor: opened from the till (no sign-in of its own).
  const [screen] = await Promise.all([
    context.waitForEvent('page'),
    pos.getByRole('button', { name: 'Customer screen' }).click(),
  ]);
  await expect(screen.getByRole('heading', { name: 'Welcome' })).toBeVisible();

  await pos.getByRole('tab', { name: 'Takeaway' }).click();
  await pos.getByRole('button', { name: '+ New takeaway order' }).click();
  await pos.getByRole('button', { name: /^Coke/ }).click();
  await pos.getByRole('button', { name: /^Coke/ }).click();
  await expect(screen.getByRole('heading', { name: 'Your order' })).toBeVisible();
  await expect(screen.getByText('Coke')).toBeVisible();
  await expect(screen.locator('.ts-total')).toContainText('GHS');

  await pos.getByLabel('Customer name').fill('Screen test');
  await pos.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(screen.getByRole('heading', { name: /^Order #\d+/ })).toBeVisible();
  const total = (await screen.locator('.ts-total dd').textContent())!.trim();
  if (process.env.QA_OUT) await screen.screenshot({ path: `${process.env.QA_OUT}/till-screen-order.png` });

  await pos.getByRole('button', { name: 'Take payment' }).click();
  await pos.getByRole('button', { name: 'CASH' }).click();
  await pos.getByLabel('Cash received').fill('100');
  await pos.getByRole('button', { name: /Complete payment|Record this payment/ }).click();
  await expect(screen.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
  await expect(screen.getByText('Your change')).toBeVisible();
  await expect(screen.locator('.ts-paid')).toContainText(total);
  if (process.env.QA_OUT) await screen.screenshot({ path: `${process.env.QA_OUT}/till-screen-paid.png` });
  // Going back on the till does not hide the change from the customer.
  await pos.getByRole('button', { name: 'Back' }).first().click();
  await expect(screen.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
  // Nothing private is shown there.
  await expect(screen.locator('body')).not.toContainText('+233');
  await context.close();
});
