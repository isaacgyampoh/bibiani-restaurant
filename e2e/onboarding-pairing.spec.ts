import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import postgres from 'postgres';

/**
 * Owner onboarding and device-initiated pairing, in the browser, on staging.
 * The verification email itself cannot be read in a test, so the single-use link is generated with
 * the Supabase admin API (exactly the link the email would contain).
 */
const env = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.dev-accounts.json', 'utf8')) as {
  restaurant: { id: string };
  accounts: Record<string, { email: string; password: string }>;
};
const API = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787';
const hosted = Boolean(process.env.STAGING_DB_PASSWORD && process.env.STAGING_POOLER_HOST);
test.skip(!hosted, 'needs the staging database (run with pnpm staging:e2e)');

const adminDb = () =>
  postgres(
    `postgresql://postgres.impairlsvhkumjzhjhti:${encodeURIComponent(process.env.STAGING_DB_PASSWORD!)}@${process.env.STAGING_POOLER_HOST}:5432/postgres`,
    { max: 1, prepare: false },
  );

test('a new owner is invited, verifies their email, sets a password and lands on the setup guide', async ({
  page,
}) => {
  const email = `owner-${randomBytes(4).toString('hex')}@example.com`;
  const sql = adminDb();
  await sql`insert into owner_invitations (restaurant_id, email, expires_at) values (${env.restaurant.id}, ${email}, now() + interval '1 day')`;
  await sql.end();

  await page.goto('/welcome');
  await expect(page.getByRole('heading', { name: 'Set up your restaurant' })).toBeVisible();
  await page.getByLabel('Owner email').fill(email);
  await page.getByRole('button', { name: 'Send verification link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  // The link from the email (single use), generated server-side for the test.
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY!,
      authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ type: 'recovery', email, redirect_to: `${API}/welcome/verify` }),
  });
  const link = ((await res.json()) as { action_link: string }).action_link;
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Welcome to MY FOOD' })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Your full name').fill('Akosua Mensah');
  const password = `${randomBytes(12).toString('base64url')}Aa1!`;
  await page.getByLabel('Choose a password').fill(password);
  await page.getByLabel('Repeat the password').fill(password);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByRole('heading', { name: 'Set up your restaurant' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/of 13 done/)).toBeVisible();
  // Owner access: the Staff page (password-only management) opens and lists the new owner.
  await page.goto('/staff');
  await expect(page.getByRole('row', { name: /Akosua Mensah/ })).toContainText('Owner');
});

test('a device shows a code; the owner enters it in Devices; the device becomes the customer display', async ({
  browser,
}) => {
  const device = await (await browser.newContext()).newPage();
  await device.goto('/pair');
  const codeBox = device.locator('.pair-code');
  await expect(codeBox).toHaveText(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/, { timeout: 20_000 });
  const code = (await codeBox.textContent())!;

  const owner = await (await browser.newContext()).newPage();
  await owner.goto('/login');
  await owner.getByLabel('Email').fill(env.accounts.owner!.email);
  await owner.getByLabel('Password').fill(env.accounts.owner!.password);
  await owner.getByRole('button', { name: 'Sign in' }).click();
  await owner.waitForURL((u) => !u.pathname.startsWith('/login'));
  await owner.goto('/devices');
  await owner
    .getByRole('row', { name: /CUSTOMER-DISPLAY-01/ })
    .getByRole('button', { name: 'Enter code from device' })
    .click();
  await owner.getByLabel('Code shown on the device').fill(code);
  await owner.getByRole('button', { name: 'Pair device', exact: true }).click();

  await device.waitForURL(/\/display/, { timeout: 30_000 });
  await expect(device.getByRole('region', { name: 'Ready' })).toBeVisible({ timeout: 20_000 });
});
