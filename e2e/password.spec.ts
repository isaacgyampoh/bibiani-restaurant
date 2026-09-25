import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/**
 * Owner / staff onboarding without anyone else knowing the password: the person opens a
 * recovery link and chooses their own password. The link is generated with the Auth admin
 * API here (no email sent); in production Supabase emails the same link.
 */
const env = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.dev-accounts.json', 'utf8')) as {
  branchId: string;
  accounts: Record<string, { email: string; password: string }>;
};
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const API = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787';

async function ownerApi<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const auth = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY!, 'content-type': 'application/json' },
    body: JSON.stringify(env.accounts.owner),
  });
  const { access_token } = (await auth.json()) as { access_token: string };
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}

test('a recovery link lets the person set their own password, then sign in with it', async ({ browser }) => {
  test.skip(!process.env.SUPABASE_SECRET_KEY, 'needs the Auth admin key to generate a link');
  const config = await ownerApi<{ roles: { id: string; name: string }[] }>('/v1/admin/configuration');
  const email = `reset.${randomUUID().slice(0, 6)}@staff.example.com`;
  const created = await ownerApi<{ staffId: string }>('/v1/admin/staff', 'POST', {
    displayName: 'Reset Tester',
    email,
    password: `${randomUUID()}A1`, // never used: the person sets their own below
    roleIds: [config.roles.find((r) => r.name === 'Waiter')!.id],
    branchId: env.branchId,
  });
  try {
    const link = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: { apikey: process.env.SUPABASE_SECRET_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'recovery', email, redirect_to: `${BASE}/set-password` }),
    });
    const { action_link } = (await link.json()) as { action_link: string };
    expect(action_link).toBeTruthy();

    const page = await (await browser.newContext()).newPage();
    await page.goto(action_link);
    await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    const chosen = `Own-${randomUUID()}`;
    await page.getByLabel('New password', { exact: true }).fill(chosen);
    await page.getByLabel('Repeat new password').fill(`${chosen}x`);
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.getByText('The two passwords do not match')).toBeVisible();
    await page.getByLabel('Repeat new password').fill(chosen);
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible(); // signed in, in the app

    // The link is single use.
    const again = await (await browser.newContext()).newPage();
    await again.goto(action_link);
    await expect(again.getByRole('heading', { name: 'Link expired' })).toBeVisible();

    // The chosen password works.
    const login = await (await browser.newContext()).newPage();
    await login.goto('/login');
    await login.getByLabel('Email').fill(email);
    await login.getByLabel('Password').fill(chosen);
    await login.getByRole('button', { name: 'Sign in' }).click();
    await expect(login.getByRole('button', { name: 'Sign out' })).toBeVisible();
  } finally {
    await ownerApi(`/v1/admin/staff/${created.staffId}`, 'POST', { isActive: false });
  }
});
