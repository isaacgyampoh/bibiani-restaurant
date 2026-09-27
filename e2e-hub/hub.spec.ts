import { type Browser, expect, type Page, test } from '@playwright/test';

/**
 * The restaurant on the in-store MY FOOD Hub, in a real browser with the real web build:
 * the hub window approves devices, a till signs in with a PIN and sells, the customer display
 * follows, and all of it keeps working when the internet goes down.
 */
const tap = async (page: Page, pin: string) => {
  for (const d of pin) await page.getByRole('button', { name: d, exact: true }).click();
};

async function connect(browser: Browser, hubWindow: Page, deviceName: string, path: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(path);
  if (path === '/') {
    // A screen that is not connected yet is sent to pairing.
    await expect(page.getByRole('heading', { name: 'Connect this screen' })).toBeVisible();
    await page.getByRole('link', { name: 'Connect this device' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Pair this device' })).toBeVisible();
  const code = page.locator('.pair-code');
  await expect(code).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await expect(page.getByText('I have a code from a manager')).toHaveCount(0);

  await hubWindow.reload();
  await hubWindow
    .getByRole('row', { name: new RegExp(deviceName) })
    .getByRole('button')
    .click();
  const dialog = hubWindow.getByRole('dialog');
  await dialog.getByLabel('Code shown on the device').fill(await code.innerText());
  await dialog.getByLabel('Manager PIN').fill('9153');
  await dialog.getByRole('button', { name: 'Connect device' }).click();
  await expect(hubWindow.getByText(`${deviceName} is connected`)).toBeVisible();
  return page;
}

test('a restaurant evening on the hub, including an internet outage', async ({ browser, request }) => {
  const hubWindow = await (await browser.newContext()).newPage();
  const problems: string[] = [];
  hubWindow.on('pageerror', (e) => problems.push(e.message));

  // The hub window on the hub PC.
  await hubWindow.goto('/hub');
  await expect(hubWindow.getByRole('heading', { name: 'MY FOOD Hub' })).toBeVisible();
  await expect(hubWindow.getByText('Connected', { exact: true })).toBeVisible();
  await expect(hubWindow.getByText('All sent')).toBeVisible();

  // Connect the customer display and a till.
  const display = await connect(browser, hubWindow, 'CUSTOMER-DISPLAY-01', '/pair');
  await expect(display.getByRole('region', { name: 'Order received' })).toBeVisible();
  const pos = await connect(browser, hubWindow, 'POS-01', '/');
  pos.on('pageerror', (e) => problems.push(e.message));

  // PIN sign-in (learnt from the cloud the first time).
  await expect(pos.getByRole('heading', { name: 'Enter your staff PIN' })).toBeVisible();
  await expect(pos.getByText('Manager sign-in (email)')).toHaveCount(0);
  await tap(pos, '4827');
  await pos.getByRole('button', { name: 'Sign in', exact: true }).click();

  const sell = async (product: string) => {
    await pos.getByRole('tab', { name: 'Takeaway' }).click();
    await pos.getByRole('button', { name: '+ New takeaway order' }).click();
    await pos.getByRole('button', { name: new RegExp(`^${product}`) }).click();
    await pos.getByRole('button', { name: 'Send to kitchen' }).click();
    const header = pos.locator('.cart strong').first();
    await expect(header).toContainText(/Takeaway #\d+/);
    const number = (await header.innerText()).match(/#(\d+)/)![1]!;
    await pos.getByRole('button', { name: 'Take payment' }).click();
    await pos.getByRole('button', { name: 'CASH' }).click();
    await pos.getByLabel('Cash received').fill('500');
    await pos.getByRole('button', { name: 'Complete payment' }).click();
    await expect(pos.locator('.cart .badge').nth(1)).toHaveText('Paid');
    return number;
  };

  const first = await sell('Coke');
  await expect(display.getByRole('region', { name: 'Order received' })).toContainText(first);

  // 7 PM: the internet goes down. Nothing changes for the staff except a clear line on the till.
  await request.post('/__test/offline');
  await expect(pos.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible({ timeout: 20_000 });
  await expect(display.getByText('Offline')).toHaveCount(0);
  const second = await sell('Meat Pie');
  await expect(display.getByRole('region', { name: 'Order received' })).toContainText(second);
  expect(await (await request.get('/__test/cloud-orders')).json()).not.toContain(Number(second));
  await hubWindow.reload();
  await expect(hubWindow.getByText('Offline', { exact: true })).toBeVisible();
  await expect(hubWindow.getByText(/waiting/)).toBeVisible();

  // Sign out and back in with the PIN while offline.
  await pos
    .getByRole('button', { name: /Lock|Sign out/ })
    .first()
    .click();
  await tap(pos, '4827');
  await pos.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(pos.getByRole('tab', { name: 'Takeaway' })).toBeVisible();

  // 9 PM: internet back. Everything reaches the cloud once.
  await request.post('/__test/online');
  await expect(pos.getByRole('status').filter({ hasText: 'Offline' })).toHaveCount(0, { timeout: 20_000 });
  await expect
    .poll(async () => (await (await request.get('/__test/cloud-orders')).json()) as number[])
    .toEqual(expect.arrayContaining([Number(first), Number(second)]));
  await hubWindow.reload();
  await expect(hubWindow.getByText('All sent')).toBeVisible();
  await hubWindow.screenshot({ path: 'test-results/hub-window.png', fullPage: true });
  const status = (await (await request.get('/hub/status')).json()) as {
    outbox: { conflicts: number; conflictList: unknown[] };
  };
  expect(status.outbox.conflictList).toEqual([]);
  expect(problems).toEqual([]);
});
