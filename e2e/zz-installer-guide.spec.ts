import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { annotate as draw, type Mark } from './guide-annotate';
import { usePasswordSignIn } from './support';

/**
 * Captures the annotated pictures (red boxes, numbers and arrows on the real buttons) for the
 * picture-led Installer Guide in docs/manual, from STAGING test data. Not part of the normal run:
 *   GUIDE_SHOTS=docs/manual/guide-images E2E_BASE_URL=https://restaurant-management-staging.vercel.app \
 *     ACCOUNTS_FILE=.staging-accounts.json npx playwright test e2e/zz-installer-guide.spec.ts
 */
const OUT = process.env.GUIDE_SHOTS;
test.skip(!OUT, 'installer guide pictures only');
const env = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.dev-accounts.json', 'utf8')) as {
  accounts: Record<string, { email: string; password: string }>;
};

const annotate = (page: Page, name: string, marks: Mark[]) => draw(page, `${OUT}/${name}.png`, marks);

async function signedIn(browser: Browser, account: string, width = 1280): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width, height: 800 } })).newPage();
  await page.goto('/login');
  await usePasswordSignIn(page);
  await page.getByLabel('Email').fill(env.accounts[account]!.email);
  await page.getByLabel('Password').fill(env.accounts[account]!.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  return page;
}
const settle = async (page: Page) => {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(800);
};

/** The real MY FOOD Printing window, filled with example data (no Windows PC here). */
async function printingWindow(browser: Browser, phase: 'pairing' | 'running'): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 900, height: 760 } })).newPage();
  await page.addInitScript((phase) => {
    const status = {
      title: 'MY FOOD Printing',
      version: '1.1.1',
      cloud: 'https://www.chefelisha.cc',
      phase,
      pairing:
        phase === 'pairing'
          ? { code: 'H4TW-9KPD', expiresAt: new Date(Date.now() + 9.5 * 60_000).toISOString() }
          : null,
      message: null,
      device: phase === 'running' ? { name: 'PRINT-AGENT-01' } : null,
      lastContactAt: new Date().toISOString(),
      printers:
        phase === 'running'
          ? [
              {
                name: 'KITCHEN-PRINTER-01',
                connection: 'network_escpos',
                address: '192.168.1.50:9100',
                reachable: true,
                paperWidthMm: 80,
              },
              {
                name: 'RECEIPT-PRINTER-01',
                connection: 'network_escpos',
                address: '192.168.1.51:9100',
                reachable: true,
                paperWidthMm: 80,
              },
            ]
          : [],
      recent: [],
    };
    Object.assign(window, {
      printing: {
        status: async () => status,
        test: async () => ({ ok: true }),
        scan: async () => [],
        usb: async () => [],
        copy: async () => undefined,
        forget: async () => undefined,
        newCode: async () => undefined,
      },
    });
  }, phase);
  await page.goto(`file://${resolve('apps/desktop/app-printing/printing.html')}`);
  await page.waitForTimeout(600);
  return page;
}

test('installer guide pictures', async ({ browser }) => {
  test.setTimeout(600_000);

  // A. Pair a till.
  const till = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await till.goto('/pair');
  const codeBox = till.locator('.pair-code');
  await expect(codeBox).toHaveText(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/, { timeout: 20_000 });
  const code = (await codeBox.textContent())!;
  await annotate(till, 'a1-till-shows-code', [
    { target: codeBox, label: 'The till shows its code', side: 'right' },
  ]);

  const owner = await signedIn(browser, 'owner');
  await owner.goto('/devices');
  await settle(owner);
  const posRow = owner.getByRole('row', { name: /POS-01/ });
  await annotate(owner, 'a2-enter-code-on-till-row', [
    { target: posRow.getByRole('cell').first(), label: 'Find the till’s name', side: 'bottom' },
    {
      target: posRow.getByRole('button', { name: 'Enter code from device' }),
      label: 'Press on THAT row',
      side: 'bottom',
    },
  ]);
  await posRow.getByRole('button', { name: 'Enter code from device' }).click();
  await owner.getByLabel('Code shown on the device').fill(code);
  await annotate(owner, 'a3-type-code-pair', [
    {
      target: owner.getByLabel('Code shown on the device'),
      label: 'Type the code from the till',
      side: 'left',
    },
    {
      target: owner.getByRole('button', { name: 'Pair device', exact: true }),
      label: 'Press Pair device',
      side: 'bottom',
    },
  ]);
  await owner.getByRole('button', { name: 'Pair device', exact: true }).click();
  const pin = till.getByRole('heading', { name: 'Enter your staff PIN' });
  await expect(pin).toBeVisible({ timeout: 30_000 });
  await annotate(till, 'a4-till-ready', [{ target: pin, label: 'Done! The till is paired', side: 'right' }]);

  // B. Printing.
  await owner.reload();
  await settle(owner);
  const panelLink = owner.getByRole('link', { name: 'MY FOOD Printing' }).first();
  if (await panelLink.isVisible().catch(() => false))
    await annotate(owner, 'b1-download-printing', [
      { target: panelLink, label: 'Download MY FOOD Printing here (on the printing PC)', side: 'bottom' },
    ]);
  const pairing = await printingWindow(browser, 'pairing');
  await annotate(pairing, 'b2-printing-code', [
    { target: pairing.locator('#code'), label: 'MY FOOD Printing shows a code', side: 'right' },
  ]);
  const agentRow = owner.getByRole('row', { name: /PRINT-AGENT-01/ });
  await annotate(owner, 'b3-enter-code-on-agent-row', [
    { target: agentRow.getByRole('cell').first(), label: 'Only the PRINT-AGENT-01 row', side: 'top' },
    {
      target: agentRow.getByRole('button', { name: 'Enter code from device' }),
      label: 'Press here, type the code, Pair device',
      side: 'top',
    },
  ]);
  const running = await printingWindow(browser, 'running');
  await annotate(running, 'b4-printing-is-on', [
    { target: running.locator('#pill'), label: 'Connected', side: 'bottom' },
    {
      target: running.getByRole('button', { name: 'Search the network' }),
      label: 'Find each printer’s address',
      side: 'right',
    },
    {
      target: running.getByRole('button', { name: 'Print test page' }).first(),
      label: 'Test each printer',
      side: 'left',
    },
  ]);

  const printerRow = owner.locator('tr', { has: owner.getByText('Printer', { exact: true }) }).first();
  await printerRow.getByRole('button', { name: 'Edit' }).click();
  const dialog = owner.getByRole('dialog');
  await annotate(owner, 'b5-edit-printer', [
    { target: dialog.getByLabel('How is it connected?'), label: 'Network or USB', side: 'left' },
    {
      target: dialog.getByLabel(/Printer IP address|Windows printer name/),
      label: 'The printer’s address',
      side: 'left',
    },
    { target: dialog.getByLabel('Printed by'), label: 'PRINT-AGENT-01', side: 'left' },
    { target: dialog.getByRole('button', { name: 'Save', exact: true }), label: 'Save', side: 'top' },
  ]);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await annotate(owner, 'b6-test-print', [
    {
      target: printerRow.getByRole('button', { name: 'Test print' }),
      label: 'Test print: it must say “printed”',
      side: 'left',
    },
  ]);

  await owner.goto('/routing');
  await settle(owner);
  const connect = owner.getByRole('button', { name: 'Connect screen or printer' }).first();
  await annotate(owner, 'b7-connect-station-printer', [
    { target: connect, label: 'Connect the kitchen printer to its station', side: 'left' },
  ]);

  await owner.goto('/devices');
  await settle(owner);
  await posRow.getByRole('button', { name: 'Edit' }).click();
  await annotate(owner, 'b8-till-receipt-printer', [
    {
      target: owner.getByRole('dialog').getByLabel('Receipt printer'),
      label: 'Choose the till’s receipt printer',
      side: 'left',
    },
    {
      target: owner.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }),
      label: 'Save',
      side: 'top',
    },
  ]);
  await owner.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  // C. Kitchen screen and customer display rows.
  const kdsRow = owner.getByRole('row', { name: /KITCHEN-01/ });
  await annotate(owner, 'c1-kitchen-row', [
    { target: kdsRow.getByRole('cell').first(), label: 'Kitchen screen: its own row', side: 'bottom' },
    {
      target: kdsRow.getByRole('button', { name: 'Enter code from device' }),
      label: 'Same steps as the till',
      side: 'bottom',
    },
  ]);

  // D. Final test order.
  const pos = await signedIn(browser, 'cashier');
  await pos.goto('/pos');
  await settle(pos);
  await pos.getByRole('tab', { name: 'Takeaway' }).click();
  await pos.getByRole('button', { name: '+ New takeaway order' }).click();
  await pos.getByRole('button', { name: /^Jollof/ }).click();
  await pos.getByLabel('Customer name').fill('Test');
  await annotate(pos, 'd1-test-order', [
    { target: pos.getByRole('button', { name: /^Jollof/ }), label: 'Tap a product', side: 'bottom' },
    {
      target: pos.getByRole('button', { name: 'Send to kitchen' }),
      label: 'Send to kitchen: the ticket must print',
      side: 'top',
    },
  ]);
  await pos.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(pos.locator('.cart strong').first()).toContainText(/Takeaway #\d+/);
  await pos.getByRole('button', { name: 'Take payment' }).click();
  await pos.getByRole('button', { name: 'CASH' }).click();
  await pos.getByLabel('Cash received').fill('100');
  await annotate(pos, 'd2-payment', [
    { target: pos.getByRole('button', { name: 'CASH' }), label: 'Cash', side: 'left' },
    { target: pos.getByLabel('Cash received'), label: 'Money received', side: 'left' },
    { target: pos.getByRole('button', { name: /Complete payment/ }), label: 'Complete payment', side: 'top' },
  ]);
  await pos.getByRole('button', { name: /Complete payment/ }).click();
  const receipt = pos.getByRole('button', { name: /Print receipt/ }).first();
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await annotate(pos, 'd3-print-receipt', [{ target: receipt, label: 'Receipt must print', side: 'top' }]);
});

test('hub guide back-office pictures', async ({ browser }) => {
  test.setTimeout(300_000);
  const owner = await signedIn(browser, 'owner');
  await owner.goto('/devices');
  await settle(owner);
  const download = owner.getByRole('link', { name: 'Download for Windows' });
  await annotate(owner, 'hb1-download-hub', [
    { target: download, label: 'Download MY FOOD Hub (on the Hub PC)', side: 'right' },
  ]);
  await owner.getByLabel(/^Name/).first().fill('HUB-01');
  await owner.getByLabel(/^Type/).selectOption('hub');
  await annotate(owner, 'hb2-add-hub-device', [
    { target: owner.getByLabel(/^Name/).first(), label: 'Name: HUB-01', side: 'bottom' },
    { target: owner.getByLabel(/^Type/), label: 'Type: MY FOOD Hub', side: 'top' },
    { target: owner.getByRole('button', { name: 'Add device' }), label: 'Add device', side: 'right' },
  ]);
  // Staging has no hub: show an example HUB-01 row (already connected) in the real Devices page.
  await owner.setViewportSize({ width: 1600, height: 800 }); // the whole HUB-01 row
  await owner.route('**/v1/admin/configuration*', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const till = json.devices.find((d: { name: string }) => d.name === 'POS-01');
    json.devices.push({
      ...till,
      id: '00000000-0000-4000-8000-00000000a0b1',
      name: 'HUB-01',
      kind: 'hub',
      paired: true,
      isActive: true,
    });
    await route.fulfill({ response, json });
  });
  await owner.route('**/v1/branches/*/operations*', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const till = json.devices.find((d: { name: string }) => d.name === 'POS-01');
    json.devices.push({
      ...till,
      id: '00000000-0000-4000-8000-00000000a0b1',
      name: 'HUB-01',
      kind: 'hub',
      paired: true,
      isActive: true,
      status: 'online',
      lastSeenAt: new Date().toISOString(),
      hub: {
        runsBranch: false,
        pendingChanges: 0,
        conflicts: 0,
        oldestPendingAt: null,
        reportedAt: new Date().toISOString(),
      },
    });
    await route.fulfill({ response, json });
  });
  await owner.reload();
  await settle(owner);
  const row = owner.getByRole('row', { name: /HUB-01/ });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await annotate(owner, 'hb3-hub-row-enter-code', [
    { target: row.getByRole('cell').first(), label: 'Only the HUB-01 row', side: 'top' },
    {
      target: row.getByRole('button', { name: 'Enter code from device' }),
      label: 'Type the Hub’s code here',
      side: 'top',
    },
  ]);
  await annotate(owner, 'hb4-run-branch-from-hub', [
    {
      target: row.getByRole('button', { name: 'Run branch from hub' }),
      label: 'Then press Run branch from hub',
      side: 'top',
    },
  ]);
});
