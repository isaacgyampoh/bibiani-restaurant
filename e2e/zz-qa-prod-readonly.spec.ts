import { expect, type Page, test } from '@playwright/test';

/**
 * Post-deploy smoke test of PRODUCTION (not part of CI). Uses no account and changes nothing:
 * production holds only the real restaurant, so it only opens public screens and checks that the
 * app loads cleanly (no console errors, no content-security-policy violations), that the API is
 * ready and that it refuses requests without a login. It never opens /pair (that would create a
 * pairing request) and never submits a form.
 *
 *   E2E_BASE_URL=https://www.chefelisha.cc QA_OUT=/tmp/prodqa npx playwright test e2e/zz-qa-prod-readonly.spec.ts
 *   (also works against the fallback https://bibiani-restaurant.vercel.app)
 */
const OUT = process.env.QA_OUT;
test.skip(
  !OUT || !/bibiani-restaurant\.vercel\.app|chefelisha\.cc/.test(process.env.E2E_BASE_URL ?? ''),
  'manual production smoke test only',
);

test('production smoke test (public screens, read-only)', async ({ browser, request }) => {
  test.setTimeout(180_000);
  const problems: string[] = [];
  const watch = (page: Page) => {
    page.on('console', (m) => {
      if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(e.message));
  };
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  watch(page);
  const shot = (name: string) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

  // API: ready, on the expected schema, and closed without a login.
  const ready = await (await request.get('/health/ready')).json();
  expect(ready.status).toBe('ready');
  expect(ready.environment).toBe('production');
  expect((await request.get('/v1/me')).status()).toBeGreaterThanOrEqual(401);

  // Sign-in screen (the first thing anyone sees).
  await page.goto('/');
  await expect(page.getByText('Chefelisha Restaurant').first()).toBeVisible();
  await expect(page.getByRole('heading').first()).toBeVisible();
  await shot('p01-sign-in');

  // Owner welcome (invitation-based onboarding), without submitting.
  await page.goto('/welcome');
  await expect(page.getByRole('heading').first()).toBeVisible();
  await shot('p02-welcome');

  // Unknown address falls back to the app, not an error page.
  await page.goto('/this-page-does-not-exist');
  await expect(page.getByText('Chefelisha Restaurant').first()).toBeVisible();

  // No demo or test restaurant is shown anywhere public.
  for (const path of ['/', '/welcome']) {
    await page.goto(path);
    await expect(page.getByText(/demo|smoke test|test restaurant/i)).toHaveCount(0);
  }

  // Web app manifest and icons load.
  expect((await request.get('/manifest.webmanifest')).ok()).toBe(true);
  expect((await request.get('/logo-512.png')).ok()).toBe(true);

  expect(problems).toEqual([]);
});
