import { expect, type Page, test } from '@playwright/test';
import { annotate as draw, type Mark } from '../e2e/guide-annotate';

/**
 * Pictures for the picture-led Hub Guide in docs/manual: the real hub window and a real till on the
 * hub (this config's real hub + in-process cloud), annotated with arrows. Not part of the normal run:
 *   pnpm --filter @rp/web build && GUIDE_SHOTS=docs/manual/guide-images \
 *     npx playwright test -c playwright.hub.config.ts e2e-hub/zz-hub-guide.spec.ts
 * The hub PC's network address and the first-run code are example values (this hub runs on
 * 127.0.0.1 and is already connected).
 */
const OUT = process.env.GUIDE_SHOTS;
test.skip(!OUT, 'hub guide pictures only');
const annotate = (page: Page, name: string, marks: Mark[]) => draw(page, `${OUT}/${name}.png`, marks);
const tap = async (page: Page, pin: string) => {
  for (const d of pin) await page.getByRole('button', { name: d, exact: true }).click();
};

/** The hub window, with the example LAN address (and optionally the first-run code) filled in. */
async function hubWindow(page: Page, firstRun = false) {
  await page.route('**/hub/status', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.addresses = ['http://192.168.1.20:8080'];
    if (firstRun) json.cloudPairing = { status: 'waiting', code: 'M3QX-7HRD' };
    await route.fulfill({ response, json });
  });
  await page.goto('/hub');
  await expect(page.getByRole('heading', { name: 'MY FOOD Hub' })).toBeVisible();
}

test('hub guide pictures', async ({ browser, request }) => {
  test.setTimeout(300_000);
  const ctx = { viewport: { width: 1280, height: 800 } };

  const first = await (await browser.newContext(ctx)).newPage();
  await hubWindow(first, true);
  await annotate(first, 'h1-hub-shows-code', [
    { target: first.locator('.pair-code'), label: 'The Hub shows a code', side: 'bottom' },
  ]);

  const hub = await (await browser.newContext(ctx)).newPage();
  await hubWindow(hub);
  await expect(hub.getByText('All sent')).toBeVisible();
  await annotate(hub, 'h3-hub-connected', [
    { target: hub.locator('.hub-card').nth(0), label: 'Connected', side: 'bottom' },
    { target: hub.locator('.hub-card').nth(2), label: 'Runs this branch: Yes', side: 'bottom' },
  ]);
  await annotate(hub, 'h4-hub-address', [
    { target: hub.locator('.hub-addresses code').first(), label: 'Write this address down', side: 'right' },
  ]);

  // A till opens the hub's address and shows a code.
  const till = await (await browser.newContext(ctx)).newPage();
  await till.goto('/pair');
  const code = till.locator('.pair-code');
  await expect(code).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await annotate(till, 'h5-till-shows-code', [
    { target: code, label: 'The till shows a code', side: 'right' },
  ]);

  await hub.reload();
  const row = hub.getByRole('row', { name: /POS-01/ });
  await annotate(hub, 'h6-hub-enter-code', [
    { target: row.getByRole('cell').first(), label: 'The till’s name', side: 'left' },
    { target: row.getByRole('button'), label: 'Enter code from device', side: 'left' },
  ]);
  await row.getByRole('button').click();
  const dialog = hub.getByRole('dialog');
  await dialog.getByLabel('Code shown on the device').fill(await code.innerText());
  await dialog.getByLabel('Manager PIN').fill('9153');
  await annotate(hub, 'h7-hub-connect-device', [
    { target: dialog.getByLabel('Code shown on the device'), label: 'Code from the till', side: 'left' },
    { target: dialog.getByLabel('Manager PIN'), label: 'A manager’s PIN', side: 'left' },
    {
      target: dialog.getByRole('button', { name: 'Connect device' }),
      label: 'Connect device',
      side: 'bottom',
    },
  ]);
  await dialog.getByRole('button', { name: 'Connect device' }).click();
  await expect(hub.getByText('POS-01 is connected')).toBeVisible();
  const pin = till.getByRole('heading', { name: 'Enter your staff PIN' });
  await expect(pin).toBeVisible({ timeout: 30_000 });
  await annotate(till, 'h8-till-ready', [
    { target: pin, label: 'Done! The till works through the Hub', side: 'right' },
  ]);

  // Internet down: the till keeps selling and says so.
  await tap(till, '4827');
  await till.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(till.getByRole('tab', { name: 'Takeaway' })).toBeVisible();
  await request.post('/__test/offline');
  const banner = till.getByRole('status').filter({ hasText: 'Offline' });
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await till.getByRole('tab', { name: 'Takeaway' }).click();
  await till.getByRole('button', { name: '+ New takeaway order' }).click();
  await till.getByRole('button', { name: /^Coke/ }).click();
  await till.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(till.locator('.cart strong').first()).toContainText(/Takeaway #\d+/);
  await annotate(till, 'h9-offline-till', [
    { target: banner, label: 'No internet: keep working', side: 'bottom' },
  ]);
  await hub.reload();
  await expect(hub.getByText('Offline', { exact: true })).toBeVisible();
  await annotate(hub, 'h10-hub-offline', [
    { target: hub.locator('.hub-card').nth(0), label: 'Internet is down', side: 'bottom' },
    { target: hub.locator('.hub-card').nth(1), label: 'Waiting to send: normal', side: 'bottom' },
  ]);
  await request.post('/__test/online');
  await expect(banner).toHaveCount(0, { timeout: 20_000 });
  await expect(async () => {
    await hub.reload();
    await expect(hub.getByText('All sent')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await annotate(hub, 'h11-hub-all-sent', [
    { target: hub.locator('.hub-card').nth(1), label: 'Internet back: everything sent', side: 'bottom' },
  ]);
});
