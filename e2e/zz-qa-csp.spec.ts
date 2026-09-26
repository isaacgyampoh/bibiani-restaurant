import { readFileSync } from 'node:fs';
import { type Browser, expect, type Page, test } from '@playwright/test';

// Manual-QA helper (not part of CI): opens every screen type and fails on any Content-Security-Policy
// violation or console error, so the security policy can never silently break the app.
const env = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE!, 'utf8')) as {
  accounts: Record<string, { email: string; password: string }>;
};
const API = process.env.E2E_BASE_URL!;
test.skip(!process.env.QA_CSP, 'manual QA only');

const problems: string[] = [];
function watch(page: Page, name: string) {
  page.on('console', (m) => {
    if (m.type() === 'error' || /Content Security Policy/i.test(m.text()))
      problems.push(`${name}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${name}: ${e.message}`));
}
async function token() {
  const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY!, 'content-type': 'application/json' },
    body: JSON.stringify(env.accounts.owner),
  });
  return ((await r.json()) as { access_token: string }).access_token;
}
async function paired(browser: Browser, name: string) {
  const h = { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' };
  const config = (await (await fetch(`${API}/v1/admin/configuration`, { headers: h })).json()) as {
    devices: { id: string; name: string }[];
  };
  const device = config.devices.find((d) => d.name === name)!;
  const { code } = (await (
    await fetch(`${API}/v1/admin/devices/${device.id}/pairing-code`, {
      method: 'POST',
      headers: h,
      body: '{}',
    })
  ).json()) as { code: string };
  const page = await (await browser.newContext()).newPage();
  watch(page, name);
  await page.goto('/pair');
  await page.getByRole('button', { name: 'I have a code from a manager' }).click();
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair device' }).click();
  await page.waitForTimeout(5000);
  return page;
}

test('no security-policy violations or console errors on any screen', async ({ browser }) => {
  test.setTimeout(300_000);
  const page = await (await browser.newContext()).newPage();
  watch(page, 'owner');
  await page.goto('/login');
  await page.getByLabel('Email').fill(env.accounts.owner!.email);
  await page.getByLabel('Password').fill(env.accounts.owner!.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  for (const path of [
    '/dashboard',
    '/orders',
    '/inventory',
    '/stock-takes',
    '/menu',
    '/routing',
    '/floor',
    '/devices',
    '/promotions',
    '/staff',
    '/reports',
    '/activity',
    '/settings',
    '/expo',
    '/pos',
  ]) {
    await page.goto(path);
    await page.waitForTimeout(2500);
  }
  await paired(browser, 'KITCHEN-01');
  await paired(browser, 'CUSTOMER-DISPLAY-01');
  await paired(browser, 'POS-01');
  expect(problems).toEqual([]);
});
