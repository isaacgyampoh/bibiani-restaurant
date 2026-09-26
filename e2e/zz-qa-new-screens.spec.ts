import { readFileSync } from 'node:fs';
import { test } from '@playwright/test';

// Manual-QA helper (not part of CI): screenshots of the handover screens.
const OUT = process.env.QA_OUT!;
const env = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE!, 'utf8')) as {
  accounts: Record<string, { email: string; password: string }>;
};
test.skip(!process.env.QA_OUT, 'manual QA only');
test('handover screens', async ({ browser }) => {
  const p = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  await p.goto('/welcome');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/n1-welcome.png` });
  await p.goto('/pair');
  await p.waitForTimeout(3000);
  await p.screenshot({ path: `${OUT}/n2-pair.png` });
  const o = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  await o.goto('/login');
  await o.getByLabel('Email').fill(env.accounts.owner!.email);
  await o.getByLabel('Password').fill(env.accounts.owner!.password);
  await o.getByRole('button', { name: 'Sign in' }).click();
  await o.waitForURL((u) => !u.pathname.startsWith('/login'));
  await o.goto('/setup');
  await o.waitForTimeout(2500);
  await o.screenshot({ path: `${OUT}/n3-setup.png`, fullPage: true });
  await o.goto('/devices');
  await o.waitForTimeout(2500);
  await o.screenshot({ path: `${OUT}/n4-devices.png`, fullPage: true });
  await o.goto('/display');
  await o.setViewportSize({ width: 1920, height: 1080 });
  await o.waitForTimeout(2500);
  await o.screenshot({ path: `${OUT}/n5-display.png` });
});
