import { readFileSync } from 'node:fs';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { usePasswordSignIn } from './support';

/**
 * Kitchen workflow NEW -> ACCEPT -> START -> READY -> DONE in the real UI (2026-10-01): a Dining
 * order from the POS, the station screen, the supervisor, a void after ACCEPT (the kitchen sees
 * VOIDED, STOP PREPARATION), a replacement item, station isolation and the phone layout.
 */
const env = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.dev-accounts.json', 'utf8')) as {
  accounts: Record<string, { email: string; password: string }>;
};
const API = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787';

async function ownerToken(): Promise<string> {
  const { email, password } = env.accounts.owner!;
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY!, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}
async function ownerApi<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${await ownerToken()}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
async function signedIn(browser: Browser, account: string, viewport = { width: 1366, height: 900 }) {
  const page = await (await browser.newContext({ viewport })).newPage();
  await page.goto('/login');
  await usePasswordSignIn(page);
  await page.getByLabel('Email').fill(env.accounts[account]!.email);
  await page.getByLabel('Password').fill(env.accounts[account]!.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  return page;
}
async function pairedScreen(browser: Browser, deviceName: string): Promise<Page> {
  const config = await ownerApi<{ devices: { id: string; name: string }[] }>('/v1/admin/configuration');
  const device = config.devices.find((d) => d.name === deviceName)!;
  const { code } = await ownerApi<{ code: string }>(
    `/v1/admin/devices/${device.id}/pairing-code`,
    'POST',
    {},
  );
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  await page.goto('/pair');
  await page.getByRole('button', { name: 'I have a code from a manager' }).click();
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair device' }).click();
  await expect(page.locator('.kds .bar')).toBeVisible({ timeout: 20_000 });
  return page;
}
/** A Dining order at a table from the POS; returns its number. */
async function diningOrder(pos: Page, table: string, products: string[]): Promise<string> {
  await pos.getByRole('tab', { name: 'Dining' }).click();
  await pos.locator('.table-card', { hasText: new RegExp(`^${table}`) }).click();
  for (const p of products) await pos.getByRole('button', { name: new RegExp(`^${p}`) }).click();
  await pos.getByRole('button', { name: 'Send to kitchen' }).click();
  const header = pos.locator('.cart strong').first();
  await expect(header).toContainText(new RegExp(`Order #\\d+ · Table ${table}`));
  return (await header.innerText()).match(/#(\d+)/)![1]!;
}

test('NEW -> ACCEPT -> START -> READY -> DONE, supervisor, void after ACCEPT, replacement, isolation, phone', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const kitchen = await pairedScreen(browser, 'KITCHEN-01');
  const pastry = await pairedScreen(browser, 'PASTRY-01');
  const pos = await signedIn(browser, 'waiter');
  const supervisor = await signedIn(browser, 'owner');

  // 1-3. A Dining order arrives as NEW ORDER; the first and only action is ACCEPT.
  const n = await diningOrder(pos, '9', ['Jollof Rice']);
  const card = kitchen.getByRole('article', { name: `Order ${n}` });
  await expect(card).toContainText('New order');
  await expect(card).toContainText('Dining · Table 9');
  await expect(card.getByRole('button', { name: 'ACCEPT' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'START' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'READY' })).toHaveCount(0);
  // Station isolation: the Pastry screen never shows the Main Kitchen ticket.
  await expect(pastry.getByRole('article', { name: `Order ${n}` })).toHaveCount(0);

  // 4-6. ACCEPT: acknowledged (by this screen), START now available; cooking has not started.
  await card.getByRole('button', { name: 'ACCEPT' }).click();
  await expect(card).toContainText('Accepted');
  await expect(card).toContainText('Accepted on KITCHEN-01');
  await expect(card.getByRole('button', { name: 'START' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'READY' })).toHaveCount(0);

  // 13. The supervisor sees the stage.
  await supervisor.goto('/expo');
  const order = supervisor.getByRole('article', { name: `Order ${n}` });
  await expect(order).toContainText('Accepted');

  // 7-12. START -> Preparing -> READY -> DONE.
  await card.getByRole('button', { name: 'START' }).click();
  await expect(card).toContainText('Preparing');
  await expect(order).toContainText('Preparing');
  await card.getByRole('button', { name: 'READY' }).click();
  await expect(card.getByRole('button', { name: 'DONE' })).toBeVisible();
  await expect(order).toContainText('READY');
  await card.getByRole('button', { name: 'DONE' }).click();
  await expect(card).toHaveCount(0);

  // 15-16. Void after ACCEPT: the kitchen sees VOIDED, STOP PREPARATION (not a vanished ticket).
  // Jollof (Main Kitchen) + Coke (Drinks): only the Jollof is voided, so the order stays open.
  const v = await diningOrder(pos, '10', ['Jollof Rice', 'Coke']);
  const vcard = kitchen.getByRole('article', { name: new RegExp(`^Order ${v}`) });
  await vcard.getByRole('button', { name: 'ACCEPT' }).click();
  await expect(vcard).toContainText('Accepted');
  const cfg = await ownerApi<{ branches: { id: string }[] }>('/v1/admin/configuration');
  const open = await ownerApi<{ id: string; orderNumber: number }[]>(
    `/v1/branches/${cfg.branches[0]!.id}/orders`,
  );
  const target = open.find((o) => String(o.orderNumber) === v)!;
  const full = await ownerApi<{ items: { id: string; name: string }[] }>(`/v1/orders/${target.id}`);
  await ownerApi(`/v1/orders/${target.id}/void-items`, 'POST', {
    requestId: crypto.randomUUID(),
    itemIds: full.items.filter((i) => /jollof/i.test(i.name)).map((i) => i.id),
    reason: 'Customer changed order',
  });
  await expect(vcard).toContainText('VOIDED · STOP PREPARATION', { timeout: 20_000 });
  await expect(vcard).toContainText('Customer changed order');
  await expect(vcard.getByRole('button', { name: 'START' })).toHaveCount(0);

  // 17. Replacement: a new item on the same order is a new NEW ticket to accept.
  await pos.reload();
  await pos.getByRole('tab', { name: 'Dining' }).click();
  await pos.locator('.table-card', { hasText: /^10/ }).click();
  await pos.getByRole('button', { name: /^Fried Rice/ }).click();
  await pos.getByRole('button', { name: 'Send to kitchen' }).click();
  const replacement = kitchen.locator('article', { hasText: /fried rice/i }).filter({ hasText: `#${v}` });
  await expect(replacement.getByRole('button', { name: 'ACCEPT' })).toBeVisible({ timeout: 20_000 });

  // 19. Phone layout: the same workflow with large touch buttons.
  const config = await ownerApi<{ stations: { id: string; name: string }[] }>('/v1/admin/configuration');
  const station = config.stations.find((s) => s.name === 'Main Kitchen')!;
  const phone = await signedIn(browser, 'owner', { width: 390, height: 844 });
  await phone.goto(`/kds?station=${station.id}`);
  const accept = phone.locator('article', { hasText: /fried rice/i }).getByRole('button', { name: 'ACCEPT' });
  await expect(accept).toBeVisible({ timeout: 20_000 });
  const box = (await accept.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  await accept.click();
  await expect(
    phone.locator('article', { hasText: /fried rice/i }).getByRole('button', { name: 'START' }),
  ).toBeVisible();
});
