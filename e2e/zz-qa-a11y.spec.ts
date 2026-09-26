import { readFileSync, writeFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { type Page, test } from '@playwright/test';

// Manual-QA helper (not part of CI): automated WCAG 2.1 A/AA checks (axe-core) on every screen type.
// Writes a JSON report; automated checks find a subset of issues, not all of them.
const env = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE!, 'utf8')) as {
  accounts: Record<string, { email: string; password: string }>;
};
test.skip(!process.env.QA_A11Y, 'manual QA only');

test('axe: sign-in, back office, POS', async ({ browser }) => {
  test.setTimeout(600_000);
  const results: Record<string, { id: string; impact: string | null; help: string; nodes: string[] }[]> = {};
  const scan = async (page: Page, name: string) => {
    await page.waitForTimeout(2000);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    results[name] = r.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? null,
      help: v.help,
      nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ')),
    }));
  };
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  for (const path of ['/login', '/welcome', '/pair']) {
    await page.goto(path);
    await scan(page, path);
  }
  await page.goto('/login');
  await page.getByLabel('Email').fill(env.accounts.owner!.email);
  await page.getByLabel('Password').fill(env.accounts.owner!.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  for (const path of [
    '/dashboard',
    '/setup',
    '/orders',
    '/inventory',
    '/stock-takes',
    '/menu',
    '/promotions',
    '/staff',
    '/reports',
    '/activity',
    '/settings',
    '/devices',
    '/floor',
    '/routing',
    '/expo',
    '/pos',
  ]) {
    await page.goto(path);
    await scan(page, path);
  }
  await page.goto('/menu');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await scan(page, '/menu (product editor)');
  writeFileSync(process.env.QA_A11Y!, JSON.stringify(results, null, 1));
});
