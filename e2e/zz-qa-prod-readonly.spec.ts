import { readFileSync } from 'node:fs';
import { type Page, test } from '@playwright/test';

// Manual-QA helper (not part of CI): READ-ONLY look at production with the demo restaurant.
// Opens screens and dialogs, never saves, sends, pays or pairs anything.
const OUT = process.env.QA_OUT!;
const demo = JSON.parse(readFileSync('.demo-credentials.json', 'utf8')) as {
  email: string;
  password: string;
};
test.skip(
  !process.env.QA_OUT || !process.env.E2E_BASE_URL?.includes('bibiani-restaurant'),
  'manual production QA only',
);
test('production read-only review', async ({ browser }) => {
  test.setTimeout(300_000);
  const shot = async (p: Page, n: string, full = true) => {
    await p.waitForTimeout(2000);
    await p.screenshot({ path: `${OUT}/${n}.png`, fullPage: full });
  };
  const p = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  await p.goto('/login');
  await shot(p, 'p01-login');
  await p.getByLabel('Email').fill(demo.email);
  await p.getByLabel('Password').fill(demo.password);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.waitForURL((u) => !u.pathname.startsWith('/login'));
  for (const [n, path] of [
    ['p02-dashboard', '/dashboard'],
    ['p03-menu', '/menu'],
    ['p05-promotions', '/promotions'],
    ['p06-orders', '/orders'],
    ['p07-supervisor', '/expo'],
    ['p08-inventory', '/inventory'],
    ['p09-stock-taking', '/stock-takes'],
    ['p10-staff', '/staff'],
    ['p11-reports', '/reports'],
    ['p12-settings', '/settings'],
    ['p13-activity', '/activity'],
  ] as const) {
    await p.goto(path);
    await shot(p, n);
  }
  await p.goto('/menu');
  await p.getByRole('button', { name: 'Edit' }).first().click();
  await shot(p, 'p04-product-editor', false);
  await p.getByRole('button', { name: 'Cancel' }).click();
  const pos = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await pos.goto('/login');
  await pos.getByLabel('Email').fill(demo.email);
  await pos.getByLabel('Password').fill(demo.password);
  await pos.getByRole('button', { name: 'Sign in' }).click();
  await pos.waitForURL((u) => !u.pathname.startsWith('/login'));
  await pos.goto('/pos');
  await pos.getByRole('tab', { name: 'Takeaway' }).click();
  await pos.getByRole('button', { name: /New takeaway order/ }).click();
  await shot(pos, 'p14-pos', false);
});
