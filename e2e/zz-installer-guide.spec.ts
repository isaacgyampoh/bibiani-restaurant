import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, expect, type Locator, type Page, test } from '@playwright/test';
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

type Side = 'left' | 'right' | 'top' | 'bottom';
interface Mark {
  target: Locator;
  label: string;
  side?: Side;
}

/** Draws the marks over the page, takes the picture, removes the marks. */
async function annotate(page: Page, name: string, marks: Mark[]) {
  await marks[0]!.target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const boxes = [];
  for (const m of marks) boxes.push(await m.target.boundingBox());
  await page.evaluate(
    ({ boxes, marks }) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const ns = 'http://www.w3.org/2000/svg';
      const layer = document.createElement('div');
      layer.id = 'guide-marks';
      layer.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:Arial,sans-serif';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('width', String(vw));
      svg.setAttribute('height', String(vh));
      svg.style.cssText = 'position:absolute;inset:0';
      svg.innerHTML =
        '<defs><marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#e11d48"/></marker></defs>';
      layer.append(svg);
      document.body.append(layer); // on the page first, so the labels can be measured
      marks.forEach((m, i) => {
        const b = boxes[i];
        if (!b) return;
        const pad = 6;
        const r = { x: b.x - pad, y: b.y - pad, w: b.width + pad * 2, h: b.height + pad * 2 };
        const box = document.createElement('div');
        box.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;border:4px solid #e11d48;border-radius:10px;box-sizing:border-box`;
        layer.append(box);
        const bubble = document.createElement('div');
        bubble.style.cssText =
          'position:absolute;background:#e11d48;color:#fff;font-weight:700;font-size:20px;line-height:1.25;padding:8px 14px;border-radius:12px;max-width:330px;width:max-content;box-sizing:border-box;box-shadow:0 4px 14px rgba(0,0,0,.3)';
        bubble.innerHTML = `<span style="display:inline-block;background:#fff;color:#e11d48;border-radius:50%;width:28px;height:28px;text-align:center;line-height:28px;margin-right:8px">${i + 1}</span> ${m.label}`;
        layer.append(bubble);
        const bw = bubble.offsetWidth;
        const bh = bubble.offsetHeight;
        const gap = 70;
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        let side = m.side ?? 'left';
        let x = 0;
        let y = 0;
        const place = () => {
          if (side === 'left') [x, y] = [r.x - gap - bw, cy - bh / 2];
          if (side === 'right') [x, y] = [r.x + r.w + gap, cy - bh / 2];
          if (side === 'top') [x, y] = [cx - bw / 2, r.y - gap - bh];
          if (side === 'bottom') [x, y] = [cx - bw / 2, r.y + r.h + gap];
        };
        place();
        if (side === 'left' && x < 8) {
          side = 'bottom';
          place();
        }
        if (side === 'right' && x + bw > vw - 8) {
          side = 'left';
          place();
        }
        x = Math.max(8, Math.min(vw - bw - 8, x));
        y = Math.max(8, Math.min(vh - bh - 8, y));
        bubble.style.left = `${x}px`;
        bubble.style.top = `${y}px`;
        const from = {
          left: [x + bw, y + bh / 2],
          right: [x, y + bh / 2],
          top: [x + bw / 2, y + bh],
          bottom: [x + bw / 2, y],
        }[side]!;
        const to = { left: [r.x, cy], right: [r.x + r.w, cy], top: [cx, r.y], bottom: [cx, r.y + r.h] }[
          side
        ]!;
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', String(from[0]));
        line.setAttribute('y1', String(from[1]));
        line.setAttribute('x2', String(to[0]));
        line.setAttribute('y2', String(to[1]));
        line.setAttribute('stroke', '#e11d48');
        line.setAttribute('stroke-width', '5');
        line.setAttribute('marker-end', 'url(#ah)');
        svg.append(line);
      });
    },
    { boxes, marks: marks.map((m) => ({ label: m.label, side: m.side })) },
  );
  await page.screenshot({ path: `${OUT}/${name}.png` });
  await page.evaluate(() => document.getElementById('guide-marks')?.remove());
}

async function signedIn(browser: Browser, account: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
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
