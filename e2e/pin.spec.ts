import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

/**
 * Staff PIN on a registered till: the owner assigns a starting PIN, the staff member signs in with
 * it on the PIN pad, chooses their own PIN (activation), locks the till, and signs in again.
 */
const env = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.dev-accounts.json', 'utf8')) as {
  branchId: string;
  accounts: Record<string, { email: string; password: string }>;
};
const API = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787';

async function ownerCall<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
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
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
const tap = async (page: Page, pin: string) => {
  for (const d of pin) await page.getByRole('button', { name: d, exact: true }).click();
};
/** A random PIN that is not a repeated digit or a simple sequence. */
function randomPin(): string {
  for (;;) {
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    const d = [...pin].map(Number);
    const step = d[1]! - d[0]!;
    if (/^(\d)\1+$/.test(pin)) continue;
    if (Math.abs(step) === 1 && d.every((x, i) => i === 0 || x - d[i - 1]! === step)) continue;
    return pin;
  }
}

test('owner assigns a PIN; the cashier activates it on the till, locks, and signs in again with their own PIN', async ({
  browser,
}) => {
  const config = await ownerCall<{
    staff: { id: string; email: string | null }[];
    devices: { id: string; name: string }[];
  }>('/v1/admin/configuration');
  const cashier = config.staff.find((s) => s.email === env.accounts.cashier!.email)!;
  const starting = randomPin();
  await ownerCall(`/v1/admin/staff/${cashier.id}/pin`, 'POST', { pin: starting });

  // Pair POS-01: the till opens on the PIN pad.
  const pos = config.devices.find((d) => d.name === 'POS-01')!;
  const { code } = await ownerCall<{ code: string }>(`/v1/admin/devices/${pos.id}/pairing-code`, 'POST', {});
  const page = await (await browser.newContext()).newPage();
  await page.goto('/pair');
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair device' }).click();
  await expect(page.getByRole('heading', { name: 'Enter your staff PIN' })).toBeVisible();

  // A wrong PIN is refused without saying why.
  await tap(page, starting === '2468' ? '1357' : '2468');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('PIN not recognised');

  // The assigned PIN works once, and asks for the staff member's own PIN.
  await tap(page, starting);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
  let own = randomPin();
  while (own === starting) own = randomPin();
  await tap(page, own);
  await page.getByRole('button', { name: 'Next' }).click();
  await tap(page, own);
  await page.getByRole('button', { name: 'Save PIN' }).click();
  await expect(page.getByText('Your PIN is set')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('tab', { name: 'Takeaway' })).toBeVisible();

  // Lock the till; the old PIN no longer works, the new one does.
  await page.getByRole('button', { name: 'Lock' }).click();
  await expect(page.getByRole('heading', { name: 'Enter your staff PIN' })).toBeVisible();
  await tap(page, starting);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('PIN not recognised');
  await tap(page, own);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('tab', { name: 'Takeaway' })).toBeVisible();
  // A PIN session is not a back-office session.
  await expect(page.getByRole('link', { name: 'Back office' })).toHaveCount(0);
});
